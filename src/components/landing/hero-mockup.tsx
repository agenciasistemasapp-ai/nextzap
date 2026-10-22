import { useEffect, useRef } from "react";

/**
 * Mockup principal do hero com flutuação, neon verde, aura e parallax 3D discreto.
 * A imagem original não é alterada: todos os efeitos são camadas/transformações ao redor dela.
 * Parallax só em desktop com mouse e sem prefers-reduced-motion; atualizado via CSS vars (sem re-render).
 */
export function HeroMockup({ src, alt }: { src: string; alt: string }) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const zone = zoneRef.current;
    const tilt = tiltRef.current;
    if (!zone || !tilt) return;
    const mq = window.matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)");
    let raf = 0;
    let nx = 0;
    let ny = 0;

    const apply = () => {
      raf = 0;
      tilt.style.setProperty("--hm-rx", `${(-ny * 3.5).toFixed(2)}deg`);
      tilt.style.setProperty("--hm-ry", `${(nx * 5).toFixed(2)}deg`);
      tilt.style.setProperty("--hm-tx", `${(nx * 10).toFixed(1)}px`);
      tilt.style.setProperty("--hm-ty", `${(ny * 6).toFixed(1)}px`);
    };
    const onMove = (e: PointerEvent) => {
      if (!mq.matches || e.pointerType !== "mouse") return;
      const r = zone.getBoundingClientRect();
      nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      nx = 0;
      ny = 0;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    zone.addEventListener("pointermove", onMove);
    zone.addEventListener("pointerleave", onLeave);
    return () => {
      zone.removeEventListener("pointermove", onMove);
      zone.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={zoneRef} className="hm-zone relative w-full max-w-[600px] sm:max-w-[720px] lg:max-w-none">
      <div className="hm-aura" aria-hidden="true" />
      <div className="hm-floor" aria-hidden="true" />
      <div className="hm-float">
        <div ref={tiltRef} className="hm-tilt">
          <img src={src} alt="" aria-hidden="true" width={1400} height={1045} decoding="async" className="hm-glow" draggable={false} />
          <img
            src={src}
            alt={alt}
            width={1400}
            height={1045}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="hm-img"
            draggable={false}
          />
        </div>
      </div>

      <style>{`
        .hm-zone { perspective: 1400px; }
        .hm-float { position: relative; animation: hm-float 4.6s ease-in-out infinite; will-change: transform; }
        .hm-tilt {
          position: relative;
          transform: translate3d(var(--hm-tx, 0), var(--hm-ty, 0), 0) rotateX(var(--hm-rx, 0deg)) rotateY(var(--hm-ry, 0deg));
          transform-style: preserve-3d;
          transition: transform .6s cubic-bezier(.22,.8,.24,1);
          will-change: transform;
        }
        .hm-img {
          position: relative; display: block; width: 100%; height: auto; object-fit: contain;
          filter:
            drop-shadow(0 0 1px rgba(57,232,121,.55))
            drop-shadow(0 28px 34px rgba(0,0,0,.55));
        }
        .hm-glow {
          position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
          pointer-events: none; user-select: none;
          filter:
            drop-shadow(0 0 10px rgba(57,232,121,.55))
            drop-shadow(0 14px 26px rgba(57,232,121,.40))
            drop-shadow(0 0 42px rgba(57,232,121,.22));
          animation: hm-pulse 4.6s ease-in-out infinite;
          will-change: opacity;
        }
        .hm-aura {
          position: absolute; left: 8%; right: 8%; top: 12%; bottom: 6%;
          border-radius: 9999px; pointer-events: none;
          background: radial-gradient(ellipse at 50% 55%, rgba(57,232,121,.30) 0%, rgba(57,232,121,.10) 40%, transparent 70%);
          filter: blur(40px);
          animation: hm-pulse 4.6s ease-in-out infinite;
          will-change: opacity;
        }
        .hm-floor {
          position: absolute; left: 18%; right: 18%; bottom: -4%; height: 9%;
          border-radius: 50%; pointer-events: none;
          background: radial-gradient(ellipse at center, rgba(0,0,0,.55) 0%, rgba(57,232,121,.12) 45%, transparent 72%);
          filter: blur(14px);
          animation: hm-floor 4.6s ease-in-out infinite;
          will-change: transform, opacity;
        }
        @keyframes hm-float {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, -13px, 0); }
        }
        @keyframes hm-pulse {
          0%, 100% { opacity: .55; }
          50% { opacity: .95; }
        }
        @keyframes hm-floor {
          0%, 100% { transform: scale(1); opacity: .9; }
          50% { transform: scale(.88); opacity: .6; }
        }

        /* Mobile/tablet: mantém flutuação e neon com menos intensidade e sem pulsar */
        @media (max-width: 1023px) {
          .hm-float { animation-name: hm-float-sm; }
          .hm-glow {
            animation: none; opacity: .7;
            filter: drop-shadow(0 0 8px rgba(57,232,121,.45)) drop-shadow(0 10px 18px rgba(57,232,121,.28));
          }
          .hm-aura { animation: none; opacity: .7; filter: blur(28px); }
          .hm-floor { animation: none; }
          .hm-tilt { transform: none; transition: none; }
        }
        @keyframes hm-float-sm {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, -10px, 0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .hm-float, .hm-glow, .hm-aura, .hm-floor { animation: none !important; }
          .hm-glow { opacity: .7; }
          .hm-tilt { transform: none !important; transition: none !important; }
        }
      `}</style>
    </div>
  );
}
