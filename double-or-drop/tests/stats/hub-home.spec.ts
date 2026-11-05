import {test,expect,type Page} from "@playwright/test";

const hub="http://localhost:3001";
async function soundProbe(page:Page){
  await page.addInitScript(()=>{
    const scope=window as unknown as {hubNotes:number[]};scope.hubNotes=[];
    const original=AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator=function(){const node=original.call(this);const schedule=node.frequency.setValueAtTime.bind(node.frequency);node.frequency.setValueAtTime=(frequency,time)=>{scope.hubNotes.push(frequency);return schedule(frequency,time);};return node;};
  });
}
const notes=(page:Page)=>page.evaluate(()=>(window as unknown as {hubNotes:number[]}).hubNotes.length);
const clear=(page:Page)=>page.evaluate(()=>{(window as unknown as {hubNotes:number[]}).hubNotes=[];});

test("all four games are discoverable in the first phone screen and the desktop gallery",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.goto(hub);
  await expect(page.locator(".game-card")).toHaveCount(4);await expect(page.getByText("4 games to play",{exact:false})).toBeVisible();
  await expect(page.getByRole("navigation",{name:"Main navigation"}).getByRole("link",{name:"Rhythm Lab",exact:true})).toHaveAttribute("href","/rhythm-lab");
  await expect(page.locator(".hero-studio-invite").getByRole("link",{name:/Make music/})).toHaveAttribute("href","/rhythm-lab");
  await expect(page.locator(".studio-promo").getByRole("link",{name:/Open Rhythm Lab/})).toHaveAttribute("href","/rhythm-lab");
  for(const size of [{width:390,height:844},{width:375,height:667},{width:320,height:640},{width:768,height:1024},{width:1440,height:900}]){
    await page.setViewportSize(size);await page.evaluate(()=>window.scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const headings=await page.locator(".game-info h3").evaluateAll(elements=>elements.map(element=>({text:element.textContent,top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom})));
    for(const heading of headings){expect(heading.top,`${heading.text} at ${size.width}px`).toBeGreaterThan(0);expect(heading.bottom,`${heading.text} below fold at ${size.width}px`).toBeLessThanOrEqual(size.height);}
    if(size.width===390||size.width===1440)await page.screenshot({path:`test-results-hub/home-${size.width}.png`});
  }
  await expect(page.getByRole("link").filter({has:page.getByRole("heading",{name:"Double or Drop",exact:true})})).toHaveAttribute("href","http://localhost:3005");expect(errors).toEqual([]);
});

test("lobby music starts on interaction, respects mute, and stops for games and stats",async({page})=>{
  await soundProbe(page);await page.goto(hub);await expect(page.locator(".game-card")).toHaveCount(4);expect(await notes(page)).toBe(0);
  await page.getByRole("button",{name:"How it works",exact:false}).click();await expect(page.getByRole("dialog")).toBeVisible();await expect.poll(()=>notes(page)).toBeGreaterThan(8);
  await page.keyboard.press("Escape");await clear(page);await expect.poll(()=>notes(page)).toBeGreaterThan(4);
  await page.getByRole("button",{name:"Mute game sounds",exact:true}).click();await clear(page);await page.getByRole("button",{name:"How it works",exact:false}).click();await page.waitForTimeout(350);expect(await notes(page)).toBe(0);await page.keyboard.press("Escape");
  await page.reload();await expect(page.getByRole("button",{name:"Enable game sounds",exact:true})).toBeVisible();expect(await notes(page)).toBe(0);
  await page.getByRole("button",{name:"Enable game sounds",exact:true}).click();await expect.poll(()=>notes(page)).toBeGreaterThan(8);
  // Keep this test on the lobby so we can observe immediate sound shutdown,
  // including while an actual game navigation would still be connecting.
  const game=page.locator(".double-drop-card");await game.evaluate(link=>link.addEventListener("click",event=>event.preventDefault(),{once:true}));await game.click();await clear(page);await page.waitForTimeout(450);expect(await notes(page)).toBe(0);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));await expect.poll(()=>notes(page)).toBeGreaterThan(4);
  await page.getByRole("link",{name:"My stats",exact:false}).first().click();await expect(page).toHaveURL(`${hub}/stats`);await expect(page.locator(".md-stats-page")).toBeVisible();await clear(page);await page.waitForTimeout(450);expect(await notes(page)).toBe(0);
});
