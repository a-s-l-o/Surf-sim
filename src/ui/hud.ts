export interface Hud {
  setLoading(frac: number, msg: string): void;
  finishLoading(): void;
  setSetIncoming(incoming: boolean): void;
  onQualityToggle(cb: (high: boolean) => void): void;
  showTiltButton(onEnable: () => Promise<boolean>): void;
}

const HUD_CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
#hud .title { position: absolute; top: calc(10px + env(safe-area-inset-top));
  left: 14px; color: rgba(255,255,255,0.92); letter-spacing: 0.18em;
  font-size: 13px; font-weight: 700; text-shadow: 0 1px 6px rgba(0,20,30,0.55); }
#hud .title small { display: block; font-size: 9px; font-weight: 500;
  letter-spacing: 0.3em; opacity: 0.75; margin-top: 2px; }
#hud .set { position: absolute; top: calc(10px + env(safe-area-inset-top));
  right: 14px; background: rgba(230,80,50,0.88); color: #fff; font-size: 11px;
  font-weight: 700; letter-spacing: 0.16em; padding: 6px 12px; border-radius: 999px;
  opacity: 0; transition: opacity 0.6s ease; }
#hud .set.on { opacity: 1; animation: hud-pulse 1.6s ease-in-out infinite; }
@keyframes hud-pulse { 50% { transform: scale(1.07); } }
#hud .attr { position: absolute; bottom: calc(8px + env(safe-area-inset-bottom));
  left: 14px; right: 14px; color: rgba(255,255,255,0.55); font-size: 9px;
  text-shadow: 0 1px 4px rgba(0,20,30,0.6); }
#hud .btns { position: absolute; bottom: calc(26px + env(safe-area-inset-bottom));
  right: 14px; display: flex; flex-direction: column; gap: 8px; }
#hud button { pointer-events: auto; background: rgba(10,40,55,0.55); color: #dff2fa;
  border: 1px solid rgba(255,255,255,0.25); border-radius: 999px; font-size: 11px;
  font-weight: 600; letter-spacing: 0.12em; padding: 8px 14px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
#hud button:active { background: rgba(30,90,115,0.7); }
`;

export function createHud(attribution: string): Hud {
  const style = document.createElement("style");
  style.textContent = HUD_CSS;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "hud";
  root.innerHTML = `
    <div class="title">BELLS BEACH<small>TORQUAY · VICTORIA</small></div>
    <div class="set" id="hud-set">SET INCOMING</div>
    <div class="btns">
      <button id="hud-tilt" style="display:none">ENABLE TILT</button>
      <button id="hud-quality">QUALITY: HIGH</button>
    </div>
    <div class="attr">${attribution}</div>
  `;
  document.body.appendChild(root);

  const setEl = root.querySelector<HTMLElement>("#hud-set")!;
  const qualityBtn = root.querySelector<HTMLButtonElement>("#hud-quality")!;
  const tiltBtn = root.querySelector<HTMLButtonElement>("#hud-tilt")!;
  const loadingEl = document.getElementById("loading");
  const loadingBar = document.getElementById("loading-bar");
  const loadingMsg = document.getElementById("loading-msg");

  let high = true;
  let qualityCb: ((high: boolean) => void) | null = null;
  qualityBtn.addEventListener("click", () => {
    high = !high;
    qualityBtn.textContent = `QUALITY: ${high ? "HIGH" : "LOW"}`;
    qualityCb?.(high);
  });

  return {
    setLoading(frac, msg) {
      if (loadingBar) loadingBar.style.width = `${Math.round(frac * 100)}%`;
      if (loadingMsg) loadingMsg.textContent = msg;
    },
    finishLoading() {
      if (loadingBar) loadingBar.style.width = "100%";
      loadingEl?.classList.add("hidden");
    },
    setSetIncoming(incoming) {
      setEl.classList.toggle("on", incoming);
    },
    onQualityToggle(cb) {
      qualityCb = cb;
    },
    showTiltButton(onEnable) {
      tiltBtn.style.display = "";
      tiltBtn.addEventListener("click", async () => {
        const ok = await onEnable();
        tiltBtn.textContent = ok ? "TILT ON" : "TILT UNAVAILABLE";
        if (ok) setTimeout(() => (tiltBtn.style.display = "none"), 1200);
      });
    },
  };
}
