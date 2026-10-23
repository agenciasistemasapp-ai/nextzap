import { supportWhatsappUrl } from "@/config/brand";

const MSG = "Olá! Tenho uma dúvida sobre a NextZap.";

/** Botão fixo de WhatsApp no canto inferior direito para dúvidas. */
export function WhatsappFloat() {
  return (
    <a
      href={`${supportWhatsappUrl}?text=${encodeURIComponent(MSG)}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Tirar dúvidas pelo WhatsApp"
      className="wa-float group fixed z-50 bottom-5 right-5 md:bottom-7 md:right-7 flex items-center gap-3"
    >
      <span className="hidden md:block pointer-events-none rounded-full px-4 py-2 text-sm font-semibold text-white/90 opacity-0 translate-x-2 transition duration-200 group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0 glass-strong">
        Dúvidas? Fale com a gente
      </span>
      <span className="relative grid place-items-center size-14 md:size-16 rounded-full text-white transition-transform duration-200 group-hover:scale-110 group-active:scale-95 wa-float-btn">
        <span className="wa-float-ring absolute inset-0 rounded-full" aria-hidden />
        <svg viewBox="0 0 32 32" className="relative size-7 md:size-8" fill="currentColor" aria-hidden>
          <path d="M16.004 3C8.82 3 3 8.82 3 16c0 2.296.6 4.537 1.74 6.51L3 29l6.66-1.71A12.95 12.95 0 0 0 16.004 29C23.18 29 29 23.18 29 16S23.18 3 16.004 3Zm0 23.64c-1.98 0-3.92-.53-5.61-1.54l-.4-.24-3.95 1.02 1.05-3.85-.26-.41A10.6 10.6 0 0 1 5.36 16c0-5.87 4.77-10.64 10.65-10.64 5.86 0 10.63 4.77 10.63 10.64 0 5.87-4.77 10.64-10.64 10.64Zm5.83-7.97c-.32-.16-1.89-.93-2.18-1.04-.29-.11-.5-.16-.72.16-.21.32-.82 1.04-1 1.25-.19.21-.37.24-.69.08-.32-.16-1.35-.5-2.57-1.59-.95-.85-1.59-1.9-1.78-2.22-.19-.32-.02-.49.14-.65.14-.14.32-.37.48-.56.16-.19.21-.32.32-.53.11-.21.05-.4-.03-.56-.08-.16-.72-1.73-.98-2.37-.26-.62-.52-.54-.72-.55h-.61c-.21 0-.56.08-.85.4-.29.32-1.11 1.09-1.11 2.66 0 1.57 1.14 3.09 1.3 3.3.16.21 2.24 3.42 5.43 4.8.76.33 1.35.52 1.81.67.76.24 1.45.21 2 .13.61-.09 1.89-.77 2.15-1.52.27-.75.27-1.39.19-1.52-.08-.13-.29-.21-.61-.37Z" />
        </svg>
      </span>
      <style>{`
        /* a landing força "a { position: relative }"; aqui precisa ficar preso na tela */
        a.wa-float.wa-float { position: fixed; z-index: 60; }
        .wa-float-btn { background: #25D366; box-shadow: 0 10px 30px -6px rgba(37,211,102,0.65), 0 0 0 1px rgba(255,255,255,0.12) inset; }
        .wa-float-ring { box-shadow: 0 0 0 0 rgba(37,211,102,0.55); animation: waPulse 2.4s ease-out infinite; }
        @keyframes waPulse {
          0% { box-shadow: 0 0 0 0 rgba(37,211,102,0.55); }
          70% { box-shadow: 0 0 0 16px rgba(37,211,102,0); }
          100% { box-shadow: 0 0 0 0 rgba(37,211,102,0); }
        }
        @media (prefers-reduced-motion: reduce) { .wa-float-ring { animation: none; } }
      `}</style>
    </a>
  );
}
