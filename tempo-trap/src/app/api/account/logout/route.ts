import { makeAccountRoutes } from "@musical-daily/accounts/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = makeAccountRoutes("tempo").logout;
