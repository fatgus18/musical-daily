import { makeAccountRoutes } from "@musical-daily/accounts/server";
export async function POST(request: Request) {
  // Reading request headers keeps account responses dynamic with Cache Components.
  request.headers.get("cookie");
  return makeAccountRoutes("blackjack").logout(request);
}
