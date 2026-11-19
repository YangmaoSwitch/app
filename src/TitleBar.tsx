import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "./api";

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Draggable strip across the top of the content area, with Windows-style caption buttons.
 *  On macOS the native traffic lights are kept (overlay title bar), so only the drag strip is drawn. */
export default function TitleBar() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    const w = getCurrentWindow();
    w.isMaximized().then(setMax);
    const un = w.onResized(() => w.isMaximized().then(setMax));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const w = () => getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      {!isMac && inTauri && (
        <div className="caption">
          <button aria-label="最小化" onClick={() => w().minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button aria-label={max ? "还原" : "最大化"} onClick={() => w().toggleMaximize()}>
            {max ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <path d="M2.5 2.5V.5h7v7h-2" />
                <rect x=".5" y="2.5" width="7" height="7" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
                <rect x=".5" y=".5" width="9" height="9" />
              </svg>
            )}
          </button>
          <button className="close" aria-label="关闭" onClick={() => w().close()}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.1"><path d="M0 0l10 10M10 0L0 10" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
