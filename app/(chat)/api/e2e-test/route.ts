import { NextResponse } from "next/server";
export async function GET() {
  return NextResponse.json({
    E2E_BYPASS_AUTH: process.env.E2E_BYPASS_AUTH,
    PLAYWRIGHT: process.env.PLAYWRIGHT,
    PORT: process.env.PORT,
  });
}
