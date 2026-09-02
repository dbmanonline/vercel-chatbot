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

/** E2E bypass is ONLY allowed in non-production environments. */
const E2E_BYPASS =
  process.env.E2E_BYPASS_AUTH === "1" && !isProductionEnvironment;

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

    const [botIdResult, authSession] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      return new ChatbotError("forbidden:api").toResponse();
    }

    // E2E bypass: only when explicitly enabled AND not in production.
    // Production MUST have E2E_BYPASS_AUTH unset so this branch is dead.
    const session = E2E_BYPASS
      ? {
          expires: new Date(Date.now() + 86_400_000).toISOString(),
          user: {
            email: "e2e@example.com",
            id: "e2e-user",
            name: "E2E Test User",
            type: "regular" as const,
          },
        }
      : authSession;

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chatModel = allowedModelIds.has(selectedChatModel)
      ? selectedChatModel
      : allowedModelIds.has(`agent-shop/${selectedChatModel}`)
        ? `agent-shop/${selectedChatModel}`
        : DEFAULT_CHAT_MODEL;

    if (!isProductionEnvironment) {
      console.log(
        "[chat] session:",
        session ? "exists" : "null",
        "user:",
        session?.user?.type ?? "null",
        "chatModel:",
        chatModel
      );
    }

    const userType: UserType = session.user.type;

    if (!E2E_BYPASS) {
      await checkIpRateLimit(ipAddress(request));

      const messageCount = await getMessageCountByUserId({
        differenceInHours: 1,
        id: session.user.id,
      });

      if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
        return new ChatbotError("rate_limit:chat").toResponse();
      }
    }

    const isToolApprovalFlow = Boolean(messages);

    let chat: Awaited<ReturnType<typeof getChatById>> | null = null;
    if (!E2E_BYPASS) {
      try {
        chat = await getChatById({ id });
      } catch {
        chat = null;
      }
    }

    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      try {
        messagesFromDb = await getMessagesByChatId({ id });
      } catch {
        messagesFromDb = [];
      }
    } else if (message?.role === "user" && !E2E_BYPASS) {
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

    if (message?.role === "user" && !E2E_BYPASS) {
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
    const MCP_SERVER_URL =
      process.env.MCP_SERVER_URL || process.env.NIGHT_WORKER_URL || "";
    const MCP_AUTH_TOKEN =
      process.env.MCP_AUTH_TOKEN || process.env.NIGHT_WORKER_TOKEN || "";
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

        // For business queries, we buffer the model's text and tool outputs so
        // the user only sees them AFTER the grounding check passes. Until
        // then we stream only a "thinking" placeholder + tool-call events
        // (no actual answer text).
        let finalAnswer = "";
        if (isBusiness && mcpHandle) {
          let currentTextId: string | null = null;
          let bufferedText = "";

          // Tee the result stream: forward tool/status events to the
          // user immediately, but stash text-delta events so we can
          // gate them on grounding.
          const tee = new TransformStream<any, any>({
            transform(chunk, controller) {
              // Forward tool/status/start/end signals so the UI can show
              // the model is working. Drop the actual text until
              // grounding is verified.
              if (
                chunk?.type === "text-delta" ||
                chunk?.type === "text-start" ||
                chunk?.type === "text-end" ||
                chunk?.type === "reasoning-delta" ||
                chunk?.type === "reasoning-start" ||
                chunk?.type === "reasoning-end"
              ) {
                if (
                  chunk.type === "text-delta" &&
                  typeof chunk.delta === "string"
                ) {
                  bufferedText += chunk.delta;
                }
                if (chunk.type === "text-start") {
                  currentTextId = chunk.id;
                }
                // Suppress text/reasoning from the live stream.
                return;
              }
              controller.enqueue(chunk);
            },
          });
          const teed = result.stream.pipeThrough(tee);

          // Forward only non-text chunks live.
          dataStream.merge(
            toUIMessageStream({
              sendReasoning: false, // never stream reasoning for business queries
              stream: teed,
            })
          );

          // Wait for the full stream to complete and capture final text.
          try {
            finalAnswer = await result.text;
          } catch (err) {
            console.warn("[chat] result.text failed:", err);
          }
          // If the SDK didn't expose text via result.text, fall back to
          // what we accumulated from text-delta events.
          if (!finalAnswer && bufferedText) {
            finalAnswer = bufferedText;
          }

          // Grounding check AFTER all MCP tool calls have completed.
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
            // Replay the buffered text now that we've verified it.
            const textId = currentTextId || generateUUID();
            dataStream.write({ id: textId, type: "text-start" });
            if (finalAnswer) {
              dataStream.write({
                delta: finalAnswer,
                id: textId,
                type: "text-delta",
              });
            }
            dataStream.write({ id: textId, type: "text-end" });
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
            // Suppress the model's text entirely. Stream ONLY the fixed
            // unavailable / unverified message.
            const override =
              check.status === "unavailable"
                ? "**[Business data unavailable]** The data service is currently unreachable or returned no sources. I will not speculate about your data. Please retry once MCP is reachable."
                : "**[Response unverified]** Tools were called but the results did not contain identifiable sources. I cannot ground this answer.";
            const oid = generateUUID();
            dataStream.write({ id: oid, type: "text-start" });
            dataStream.write({ delta: override, id: oid, type: "text-delta" });
            dataStream.write({ id: oid, type: "text-end" });
            dataStream.write({
              data: {
                citations: [],
                issues: check.issues,
                sources: 0,
                status: check.status,
              },
              transient: true,
              type: "data-grounding-status",
            });
          }
        } else {
          // Non-business queries: stream normally.
          dataStream.merge(
            toUIMessageStream({
              sendReasoning: isReasoningModel,
              stream: result.stream,
            })
          );
          try {
            finalAnswer = await result.text;
          } catch (err) {
            console.warn("[chat] result.text failed:", err);
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
        if (E2E_BYPASS) {
          return;
        }
        try {
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
        } catch {
          // DB unavailable — non-fatal.
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

    console.error("Unhandled error in chat API:", {
      message: (error as Error).message,
      name: (error as Error).name,
      stack: (error as Error).stack,
      vercelId,
    });
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
