import Encore from "@/components/encore";
export default function Page(){return <Encore hubUrl={process.env.NEXT_PUBLIC_HUB_URL||"http://localhost:3001"}/>;}
