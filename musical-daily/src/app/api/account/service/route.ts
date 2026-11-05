import { accountHandlers } from "@/lib/account-handlers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return accountHandlers().service(request); }
