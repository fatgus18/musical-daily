import type { Metadata } from "next";
import { DropRooms } from "@/components/drop-rooms";
import "./rooms.css";

export const metadata:Metadata={title:"Double or Drop Co-op — Musical Daily",description:"One vault. Three lives. Your whole crew. Pass the turn, compare real songs and build a shared score with friends."};
export default function Page(){return <DropRooms/>;}
