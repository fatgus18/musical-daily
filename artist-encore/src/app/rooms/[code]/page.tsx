import type { Metadata } from "next";
import EncoreRooms from "@/components/encore-rooms";
import { hubHref } from "@/lib/app-path";
import "../rooms.css";

export const metadata: Metadata = {title:"Your Encore Room — Musical Daily",robots:{index:false,follow:false}};
export default async function Page({params}:{params:Promise<{code:string}>}){const {code}=await params;return <EncoreRooms hubUrl={hubHref()} initialCode={code}/>;}
