import { accountHandlers } from "@/lib/account-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return accountHandlers().authorize(request); }
