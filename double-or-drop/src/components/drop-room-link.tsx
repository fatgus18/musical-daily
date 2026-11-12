import { withBasePath } from "@/lib/app-path";
import "./drop-room-link.css";

export function DropRoomLink(){return <a className="drop-room-invite" href={withBasePath("/rooms")}><span className="drop-room-invite-icon" aria-hidden="true">2×<i>+1</i></span><span><strong>Double down. Together.</strong><small>Co-op rooms · Pass the turn. Protect one shared vault.</small></span><b aria-hidden="true">↗</b></a>;}
