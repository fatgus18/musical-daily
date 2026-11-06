import {NextRequest} from "next/server";
import {makeAccountRoutes} from "@musical-daily/accounts/server";
import {anonymousIdentity} from "./http";
import {claimGuestGames} from "./account-results";
import {store,transaction} from "./store";
export const accountRoutes=makeAccountRoutes("double-drop",{async onLogin(user,request){
  const {player}=anonymousIdentity(new NextRequest(request));const db=await store();await transaction(db,async tx=>claimGuestGames(tx,player,user.id));
}});
