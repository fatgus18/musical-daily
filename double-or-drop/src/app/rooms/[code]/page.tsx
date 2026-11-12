import type { Metadata } from "next";
import { DropRooms } from "@/components/drop-rooms";
import "../rooms.css";

export const metadata:Metadata={title:"Your Co-op Room — Double or Drop",robots:{index:false,follow:false}};
export default async function Page({params}:{params:Promise<{code:string}>}){const {code}=await params;return <DropRooms initialCode={code}/>;}
