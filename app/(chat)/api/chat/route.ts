import { geolocation, ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  allowedModelIds,
  chatModels,
  DEFAULT_CHAT_MODEL,
  getCapabilities,
  getModelAvailability,
} from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
// MCP integration - request-scoped client to Night Worker
import { getMcpTools, type McpHandle } from "@/lib/mcp/client";
import { verifyGrounding } from "@/lib/mcp/grounding";
import {
  buildMcpTools,
  createMcpExecutions,
  isBusinessDataQuery,
} from "@/lib/mcp/tools";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

const HEALTH_CHECK_DELAY_MS = 9000;

function isModelStreamActivity(chunk: { type: string }) {
  return !["start", "start-step", "finish-step", "finish", "raw"].includes(
    chunk.type
  );
}

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const [botIdResult, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chatModel = allowedModelIds.has(selectedChatModel)
      ? selectedChatModel
      : DEFAULT_CHAT_MODEL;

    await checkIpRateLimit(ipAddress(request));

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      differenceInHours: 1,
      id: session.user.id,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: "New chat",
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      city,
      country,
      latitude,
      longitude,
    };

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: new Date(),
            id: message.id,
            parts: message.parts,
            role: "user",
          },
        ],
      });
    }

    const modelConfig = chatModels.find((m) => m.id === chatModel);
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;

    const modelMessages = await convertToModelMessages(uiMessages);

    // Detect business-data queries (Vietnamese + English triggers).
    // MCP is REQUIRED for these - no LLM fallback.
    const businessQueryText = (() => {
      for (const m of [...uiMessages].reverse()) {
        if (m.role !== "user") {
          continue;
        }
        const text = (m.parts as any[])
          ?.filter((p: any) => p.type === "text")
          ?.map((p: any) => p.text)
          ?.join("\n");
        return text ?? null;
      }
      return null;
    })();
    const isBusiness =
      !!businessQueryText && isBusinessDataQuery(businessQueryText);

    // MCP setup - request-scoped client (NOT a singleton).
    const MCP_ENABLED = process.env.MCP_ENABLED === "true";
    const MCP_SERVER_URL = process.env.MCP_SERVER_URL || "";
    const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
    const MCP_TIMEOUT_MS = Number.parseInt(
      process.env.MCP_TIMEOUT_MS || "30000",
      10
    );

    let mcpHandle: McpHandle | null = null;
    let mcpConnectError: string | null = null;
    const tracker = createMcpExecutions();

    if (
      MCP_ENABLED &&
      MCP_SERVER_URL &&
      MCP_AUTH_TOKEN.length >= 32 &&
      requestBody.selectedChatModel
    ) {
      try {
        mcpHandle = await getMcpTools({
          authToken: MCP_AUTH_TOKEN,
          serverUrl: MCP_SERVER_URL,
          signal: request.signal,
          timeoutMs: MCP_TIMEOUT_MS,
        });
      } catch (err) {
        mcpConnectError = err instanceof Error ? err.message : String(err);
        console.error("[MCP] Connection failed:", mcpConnectError);
      }
    } else if (isBusiness) {
      mcpConnectError =
        "MCP is required for business data questions but was not " +
        "configured (check MCP_ENABLED, MCP_SERVER_URL, MCP_AUTH_TOKEN>=32).";
    }

    // Business query + MCP unavailable = refuse to fall back to LLM.
    if (isBusiness && !mcpHandle) {
      const errMsg =
        `**[Business data unavailable]** ${mcpConnectError || "MCP unavailable"}. ` +
        "I will not speculate about your data. Please retry once MCP is reachable.";
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          const id1 = generateUUID();
          writer.write({ id: id1, type: "text-start" });
          writer.write({ delta: errMsg, id: id1, type: "text-delta" });
          writer.write({ id: id1, type: "text-end" });
          await Promise.resolve();
        },
        generateId: generateUUID,
        onError: () => errMsg,
      });
      return createUIMessageStreamResponse({ stream });
    }

    const mcpTools = mcpHandle
      ? buildMcpTools({
          handle: mcpHandle,
          signal: request.signal,
          timeoutMs: MCP_TIMEOUT_MS,
          tracker,
        })
      : null;

    // MCP close helper, attached to request.signal + stream lifecycle hooks.
    let mcpClosed = false;
    const closeMcpNow = () => {
      if (mcpHandle && !mcpClosed) {
        mcpClosed = true;
        mcpHandle.close().catch((err) => {
          console.error("[MCP] close failed:", err);
        });
      }
    };
    if (request.signal) {
      request.signal.addEventListener("abort", closeMcpNow, { once: true });
    }
    after(closeMcpNow);

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const modelName = modelConfig?.name ?? chatModel;
        let hasModelActivity = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;

        const clearHealthCheckTimer = () => {
          if (healthCheckTimer) {
            clearTimeout(healthCheckTimer);
          }
        };

        const writeWaitingStatus = (
          phase: WaitingStatusData["phase"],
          messageText: string
        ) => {
          if (hasModelActivity && phase !== "thinking") {
            return;
          }
          dataStream.write({
            data: {
              message: messageText,
              modelId: chatModel,
              modelName,
              phase,
            },
            transient: true,
            type: "data-waiting-status",
          });
        };

        writeWaitingStatus("waiting", "Waiting...");

        healthCheckTimer = setTimeout(() => {
          getModelAvailability(chatModel)
            .then((availability) => {
              if (availability === "impacted") {
                writeWaitingStatus(
                  "health",
                  `${modelName} may be slow or unavailable right now...`
                );
              } else {
                writeWaitingStatus("still-waiting", "Still waiting...");
              }
            })
            .catch(() => {
              writeWaitingStatus("still-waiting", "Still waiting...");
            });
        }, HEALTH_CHECK_DELAY_MS);

        const markModelActive = () => {
          if (hasModelActivity) {
            return;
          }
          hasModelActivity = true;
          clearHealthCheckTimer();
          writeWaitingStatus("thinking", "Thinking...");
        };

        const stopWaitingStatus = () => {
          hasModelActivity = true;
          clearHealthCheckTimer();
        };

        const result = streamText({
          activeTools:
            isReasoningModel && !supportsTools
              ? []
              : mcpTools
                ? [
                    "search_records",
                    "group_records",
                    "aggregate_data",
                    "sum_quantity",
                    "top_customers",
                  ]
                : [
                    "getWeather",
                    "createDocument",
                    "editDocument",
                    "updateDocument",
                    "requestSuggestions",
                  ],
          instructions: systemPrompt({ requestHints, supportsTools }),
          messages: modelMessages,
          model: getLanguageModel(chatModel),
          onAbort() {
            stopWaitingStatus();
            closeMcpNow();
          },
          onChunk({ chunk }) {
            if (isModelStreamActivity(chunk)) {
              markModelActive();
            }
          },
          onEnd() {
            stopWaitingStatus();
            closeMcpNow();
          },
          onError() {
            stopWaitingStatus();
            closeMcpNow();
          },
          providerOptions: {
            ...(modelConfig?.gatewayOrder && {
              gateway: { order: modelConfig.gatewayOrder },
            }),
            ...(modelConfig?.reasoningEffort && {
              openai: { reasoningEffort: modelConfig.reasoningEffort },
            }),
          },
          stopWhen: isStepCount(5),
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          tools: mcpTools
            ? {
                ...mcpTools,
                getWeather,
              }
            : {
                createDocument: createDocument({
                  dataStream,
                  modelId: chatModel,
                  session,
                }),
                editDocument: editDocument({ dataStream, session }),
                getWeather,
                requestSuggestions: requestSuggestions({
                  dataStream,
                  modelId: chatModel,
                  session,
                }),
                updateDocument: updateDocument({
                  dataStream,
                  modelId: chatModel,
                  session,
                }),
              },
        });

        dataStream.merge(
          toUIMessageStream({
            sendReasoning: isReasoningModel,
            stream: result.stream,
          })
        );

        // Wait for stream to fully complete so all MCP tool calls have run.
        let finalAnswer = "";
        try {
          finalAnswer = await result.text;
        } catch (err) {
          console.warn("[chat] result.text failed:", err);
        }

        // Grounding check AFTER all MCP tool calls have completed.
        if (isBusiness && mcpHandle) {
          const check = verifyGrounding(
            finalAnswer,
            tracker.executions.map((rec) => ({
              args: rec.args,
              result: rec.result,
              sources: rec.sources,
              toolName: rec.toolName,
            }))
          );
          if (check.status === "verified") {
            dataStream.write({
              data: {
                citations: check.citations,
                issues: [],
                sources: check.citations.length,
                status: "verified",
              },
              transient: true,
              type: "data-grounding-status",
            });
          } else {
            const override =
              check.status === "unavailable"
                ? "\n\n**[Business data unavailable]** MCP server is " +
                  "currently unreachable or returned no sources. " +
                  "I will not speculate about your data. Please retry once MCP is reachable."
                : "\n\n**[Response unverified]** Tools were called but the " +
                  "results did not contain identifiable sources. " +
                  "I cannot ground this answer.";
            dataStream.write({
              id: "grounding-override",
              type: "text-start",
            });
            dataStream.write({
              delta: override,
              id: "grounding-override",
              type: "text-delta",
            });
            dataStream.write({
              id: "grounding-override",
              type: "text-end",
            });
            dataStream.write({
              data: {
                citations: check.citations,
                issues: check.issues,
                sources: 0,
                status: check.status,
              },
              transient: true,
              type: "data-grounding-status",
            });
          }
        }

        // Close MCP at the end of the stream lifecycle.
        closeMcpNow();

        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ data: title, type: "data-chat-title" });
            updateChatTitleById({ chatId: id, title });
          } catch {
            /* non-fatal */
          }
        }
      },
      generateId: generateUUID,
      onEnd: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          await Promise.all(
            finishedMessages.map(async (finishedMsg) => {
              const existingMsg = uiMessages.find(
                (m) => m.id === finishedMsg.id
              );
              if (existingMsg) {
                await updateMessage({
                  id: finishedMsg.id,
                  parts: finishedMsg.parts,
                });
                return;
              }

              await saveMessages({
                messages: [
                  {
                    attachments: [],
                    chatId: id,
                    createdAt: new Date(),
                    id: finishedMsg.id,
                    parts: finishedMsg.parts,
                    role: finishedMsg.role,
                  },
                ],
              });
            })
          );
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              attachments: [],
              chatId: id,
              createdAt: new Date(),
              id: currentMessage.id,
              parts: currentMessage.parts,
              role: currentMessage.role,
            })),
          });
        }
      },
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";
        }
        return "Oops, an error occurred!";
      },
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
    });

    return createUIMessageStreamResponse({
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ chatId: id, streamId });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch {
          /* non-critical */
        }
      },
      stream,
    });
    // MCP cleanup is wired into streamText onAbort/onError/onEnd,
    // request.signal abort listener, and after() — NOT after return.
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatbotError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
