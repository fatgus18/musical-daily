import type { Metadata } from "next";
import EncoreRooms from "@/components/encore-rooms";
import { hubHref } from "@/lib/app-path";
import "./rooms.css";

export const metadata: Metadata = {title:"Encore Rooms — Play with friends",description:"Same artist. Same ten songs. Invite up to seven friends and find out who knows the music first."};
export default function Page(){return <EncoreRooms hubUrl={hubHref()}/>;}
