import { readSession } from "@/lib/session";
import { loadAccountMix, saveAccountMix } from "@/lib/account-game";
import { sameOrigin } from "@/lib/request-origin";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const { token } = await request.json();
    const session = readSession(token);
    const account = await loadAccountMix(request, session.date);
    if (!account || !session.accountId || session.accountId !== account.user.id) return Response.json({ error: "This round belongs to a different player. Reload your mix." }, { status: 409 });
    const mix = account.mix;
    if (!mix || mix.session.results.length !== session.results.length || mix.session.results.length >= 5) return Response.json({ error: "This mix changed on another device. Reload to continue." }, { status: 409 });
    if (mix.deadline) return Response.json({ deadline: mix.deadline }, { headers: { "Cache-Control": "no-store" } });
    const deadline = Date.now() + 15000;
    const saved = await saveAccountMix(request, { ...mix, deadline }, account.revision);
    if (saved.conflict) return Response.json({ error: "This round changed on another device. Reload to continue." }, { status: 409 });
    return Response.json({ deadline }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Your guessing timer couldn't sync. Retry when your connection returns." }, { status: 503 }); }
}
