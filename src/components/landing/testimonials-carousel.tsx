import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import fornoNobre from "@/assets/depoimentos/forno-nobre.webp.asset.json";
import bellaforma from "@/assets/depoimentos/bellaforma.webp.asset.json";
import performanceStudio from "@/assets/depoimentos/performance-studio.webp.asset.json";
import sorrisos from "@/assets/depoimentos/sorrisos.webp.asset.json";
import domCorte from "@/assets/depoimentos/dom-corte.webp.asset.json";

const SLIDES = [
  { src: bellaforma.url, alt: "Depoimento da BellaForma Estética no WhatsApp sobre o atendimento com a NextZap" },
  { src: domCorte.url, alt: "Depoimento da Barbearia Dom Corte no WhatsApp sobre o atendimento com a NextZap" },
  { src: sorrisos.url, alt: "Depoimento de clínica odontológica no WhatsApp sobre o atendimento com a NextZap" },
  { src: performanceStudio.url, alt: "Depoimento do Performance Studio no WhatsApp sobre o atendimento com a NextZap" },
  { src: fornoNobre.url, alt: "Depoimento da Forno Nobre no WhatsApp sobre o atendimento com a NextZap" },
];

const AUTOPLAY_MS = 5000;
const TRANSITION_MS = 800;

/** Posição relativa ao slide ativo, normalizada para o intervalo mais curto (loop infinito). */
function relOffset(i: number, active: number, n: number) {
  let d = (i - active) % n;
  if (d > n / 2) d -= n;
  if (d < -n / 2) d += n;
  return d;
}

export function TestimonialsCarousel() {
  const n = SLIDES.length;
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const lockRef = useRef(false);
  const touchX = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const go = useCallback(
    (dir: 1 | -1) => {
      if (lockRef.current) return;
      lockRef.current = true;
      setActive((a) => (a + dir + n) % n);
      window.setTimeout(() => {
        lockRef.current = false;
      }, reduced ? 50 : TRANSITION_MS);
    },
    [n, reduced],
  );

  // Autoplay: um único timer, recriado a cada troca (navegação manual reinicia a contagem).
  useEffect(() => {
    if (paused || reduced) return;
    const t = window.setTimeout(() => go(1), AUTOPLAY_MS);
    return () => window.clearTimeout(t);
  }, [active, paused, reduced, go]);

  return (
    <div
      className="tc-root relative mx-auto max-w-5xl"
      onPointerEnter={(e) => e.pointerType === "mouse" && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setPaused(false)}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
      role="region"
      aria-roledescription="carrossel"
      aria-label="Depoimentos de clientes"
    >
      <div className="tc-stage">
        {SLIDES.map((s, i) => {
          const off = relOffset(i, active, n);
          const pos = off === 0 ? "center" : off === 1 ? "right" : off === -1 ? "left" : off > 0 ? "out-right" : "out-left";
          return (
            <figure
              key={s.src}
              className="tc-card"
              data-pos={pos}
              aria-hidden={off !== 0}
              aria-roledescription="slide"
              aria-label={`${i + 1} de ${n}`}
              onClick={() => (off === 1 ? go(1) : off === -1 ? go(-1) : undefined)}
            >
              <img
                src={s.src}
                alt={s.alt}
                width={720}
                height={1280}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            </figure>
          );
        })}

        <button type="button" className="tc-arrow tc-arrow-left" onClick={() => go(-1)} aria-label="Depoimento anterior">
          <ChevronLeft className="size-6" strokeWidth={2.25} />
        </button>
        <button type="button" className="tc-arrow tc-arrow-right" onClick={() => go(1)} aria-label="Próximo depoimento">
          <ChevronRight className="size-6" strokeWidth={2.25} />
        </button>
      </div>

      <div className="mt-8 flex justify-center gap-2" aria-hidden="true">
        {SLIDES.map((s, i) => (
          <span key={s.src} className="tc-dot" data-on={i === active} />
        ))}
      </div>

      <style>{`
        .tc-root { --tc-w: 290px; --tc-gap: 250px; --tc-side-scale: .82; }
        @media (max-width: 1023px) { .tc-root { --tc-w: 260px; --tc-gap: 200px; --tc-side-scale: .76; } }
        @media (max-width: 639px)  { .tc-root { --tc-w: 220px; --tc-gap: 150px; --tc-side-scale: .7; } }

        .tc-stage {
          position: relative;
          height: calc(var(--tc-w) * 1.779 + 80px);
          overflow: hidden;
          touch-action: pan-y;
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 9%, #000 91%, transparent 100%);
          mask-image: linear-gradient(90deg, transparent 0, #000 9%, #000 91%, transparent 100%);
        }
        .tc-card {
          position: absolute; top: 40px; left: 50%;
          width: var(--tc-w); margin: 0 0 0 calc(var(--tc-w) / -2);
          aspect-ratio: 940 / 1672;
          border-radius: 22px;
          background: #04100A;
          transition:
            transform ${TRANSITION_MS}ms cubic-bezier(.22,.8,.24,1),
            opacity ${TRANSITION_MS}ms cubic-bezier(.22,.8,.24,1),
            filter ${TRANSITION_MS}ms cubic-bezier(.22,.8,.24,1),
            box-shadow ${TRANSITION_MS}ms ease;
          will-change: transform, opacity, filter;
          user-select: none;
        }
        .tc-card img { width: 100%; height: 100%; object-fit: contain; display: block; border-radius: 22px; }
        .tc-card::after {
          content: ""; position: absolute; inset: 0; border-radius: 22px; pointer-events: none;
          box-shadow: 0 0 34px 6px rgba(57,232,121,.35);
          opacity: 0; transition: opacity ${TRANSITION_MS}ms ease;
        }
        .tc-card[data-pos="center"]::after { opacity: 1; animation: tc-pulse 3.2s ease-in-out ${TRANSITION_MS}ms infinite; }

        .tc-card[data-pos="center"] {
          transform: translateX(0) scale(1);
          opacity: 1; filter: none; z-index: 3;
          box-shadow:
            0 0 0 2px #39E879,
            0 0 18px 2px rgba(57,232,121,.55),
            0 0 60px 6px rgba(57,232,121,.22),
            0 30px 60px -20px rgba(0,0,0,.6);
        }
        .tc-card[data-pos="left"],
        .tc-card[data-pos="right"] {
          opacity: .55; filter: blur(3px) saturate(.85); z-index: 2; cursor: pointer;
          box-shadow: 0 0 0 1px rgba(57,232,121,.18), 0 20px 40px -20px rgba(0,0,0,.6);
        }
        .tc-card[data-pos="left"]  { transform: translateX(calc(var(--tc-gap) * -1)) scale(var(--tc-side-scale)); }
        .tc-card[data-pos="right"] { transform: translateX(var(--tc-gap)) scale(var(--tc-side-scale)); }
        .tc-card[data-pos="out-left"],
        .tc-card[data-pos="out-right"] { opacity: 0; filter: blur(6px); z-index: 1; pointer-events: none; }
        .tc-card[data-pos="out-left"]  { transform: translateX(calc(var(--tc-gap) * -2)) scale(.6); }
        .tc-card[data-pos="out-right"] { transform: translateX(calc(var(--tc-gap) * 2)) scale(.6); }

        @keyframes tc-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .45; }
        }

        .tc-root .tc-arrow {
          position: absolute; top: 50%; z-index: 5; transform: translateY(-50%);
          width: 52px; height: 52px; border-radius: 9999px;
          display: grid; place-items: center;
          color: #39E879;
          background: rgba(4,16,10,.7);
          border: 1px solid rgba(57,232,121,.4);
          backdrop-filter: blur(8px);
          transition: box-shadow .25s ease, border-color .25s ease, background .25s ease, transform .25s ease;
        }
        .tc-root .tc-arrow:hover, .tc-root .tc-arrow:focus-visible {
          border-color: #39E879; background: rgba(4,16,10,.85);
          box-shadow: 0 0 0 1px #39E879, 0 0 22px rgba(57,232,121,.5);
          outline: none;
        }
        .tc-root .tc-arrow:active { transform: translateY(-50%) scale(.94); }
        .tc-root .tc-arrow-left { left: calc(50% - var(--tc-w) / 2 - 76px); }
        .tc-root .tc-arrow-right { right: calc(50% - var(--tc-w) / 2 - 76px); }
        @media (max-width: 639px) {
          .tc-root .tc-arrow { width: 44px; height: 44px; }
          .tc-root .tc-arrow-left { left: 6px; }
          .tc-root .tc-arrow-right { right: 6px; }
        }

        .tc-dot { width: 8px; height: 8px; border-radius: 9999px; background: rgba(57,232,121,.25); transition: width .4s ease, background .4s ease; }
        .tc-dot[data-on="true"] { width: 26px; background: #39E879; box-shadow: 0 0 10px rgba(57,232,121,.6); }

        @media (prefers-reduced-motion: reduce) {
          .tc-card, .tc-dot, .tc-root .tc-arrow { transition: none !important; }
          .tc-card[data-pos="center"]::after { animation: none; }
        }
      `}</style>
    </div>
  );
}
