import { withBasePath } from "@/lib/app-path";
import "./encore-room-link.css";

export function EncoreRoomLink(){return <a className="encore-room-invite" href={withBasePath("/rooms")}><span className="encore-room-invite-icon" aria-hidden="true">♫<i>+1</i></span><span><strong>Bring your biggest fan.</strong><small>Encore Rooms · Same songs. Up to 8 friends. Who knows it first?</small></span><b aria-hidden="true">↗</b></a>;}
