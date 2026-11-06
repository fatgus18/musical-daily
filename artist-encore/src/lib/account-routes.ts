import {NextRequest} from "next/server";
import {makeAccountRoutes} from "@musical-daily/accounts/server";
import {anonymousIdentity} from "./http";
import {claimGuestGames} from "./account-results";
import {store,transaction} from "./store";
export const accountRoutes=makeAccountRoutes("encore",{async onLogin(user,request){const {player}=anonymousIdentity(new NextRequest(request));const db=await store();await transaction(db,tx=>claimGuestGames(tx,player,user.id));}});
