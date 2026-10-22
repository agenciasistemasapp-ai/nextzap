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
      <div className="hm-halo" aria-hidden="true" />
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
        /* Aura: camadas de luz independentes ATRÁS do mockup, ultrapassando seus limites */
        .hm-aura, .hm-halo, .hm-floor { position: absolute; pointer-events: none; z-index: 0; }
        .hm-float { z-index: 1; }
        .hm-aura {
          left: -8%; right: -8%; top: -4%; bottom: -16%;
          border-radius: 50%;
          background:
            radial-gradient(ellipse 55% 50% at 50% 62%, rgba(57,232,121,.62) 0%, rgba(57,232,121,.30) 35%, rgba(57,232,121,.08) 62%, transparent 78%);
          filter: blur(34px);
          animation: hm-aura 4.6s ease-in-out infinite;
          will-change: opacity, transform;
        }
        .hm-halo {
          left: -24%; right: -24%; top: -22%; bottom: -30%;
          border-radius: 50%;
          background:
            radial-gradient(ellipse 50% 46% at 50% 58%, rgba(57,232,121,.22) 0%, rgba(57,232,121,.09) 45%, transparent 72%);
          filter: blur(70px);
          animation: hm-halo 4.6s ease-in-out infinite;
          will-change: opacity;
        }
        .hm-floor {
          left: 10%; right: 10%; bottom: -9%; height: 16%;
          border-radius: 50%;
          background:
            radial-gradient(ellipse at center, rgba(57,232,121,.55) 0%, rgba(57,232,121,.22) 38%, transparent 70%);
          filter: blur(18px);
          animation: hm-floor 4.6s ease-in-out infinite;
          will-change: transform, opacity;
        }
        @keyframes hm-float {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, -13px, 0); }
        }
        /* Pulsação sincronizada com a flutuação: luz mais intensa quando o mockup está no alto */
        @keyframes hm-pulse {
          0%, 100% { opacity: .5; }
          50% { opacity: .9; }
        }
        @keyframes hm-aura {
          0%, 100% { opacity: .6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.04); }
        }
        @keyframes hm-halo {
          0%, 100% { opacity: .55; }
          50% { opacity: .9; }
        }
        @keyframes hm-floor {
          0%, 100% { transform: scale(1); opacity: .95; }
          50% { transform: scale(.86); opacity: .6; }
        }

        /* Mobile/tablet: mantém flutuação, aura e profundidade com menos intensidade e sem pulsar */
        @media (max-width: 1023px) {
          .hm-float { animation-name: hm-float-sm; }
          .hm-glow {
            animation: none; opacity: .6;
            filter: drop-shadow(0 0 8px rgba(57,232,121,.40)) drop-shadow(0 10px 18px rgba(57,232,121,.25));
          }
          .hm-aura { animation: none; opacity: .75; filter: blur(24px); left: -4%; right: -4%; }
          .hm-halo { animation: none; opacity: .6; left: -6%; right: -6%; filter: blur(40px); }
          .hm-floor { animation: none; opacity: .8; }
          .hm-tilt { transform: none; transition: none; }
        }
        @keyframes hm-float-sm {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, -10px, 0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .hm-float, .hm-glow, .hm-aura, .hm-halo, .hm-floor { animation: none !important; }
          .hm-glow { opacity: .6; }
          .hm-aura { opacity: .8; }
          .hm-tilt { transform: none !important; transition: none !important; }
        }
      `}</style>
    </div>
  );
}
