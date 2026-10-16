import type { MetadataRoute } from "next";

/** App instalável (iPhone pelo Safari → Adicionar à Tela de Início; Android/desktop pelo navegador). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Finanças — Finance AI",
    short_name: "Finanças",
    description: "Gestão financeira da família, com registro pelo WhatsApp.",
    lang: "pt-BR",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f4f6fa",
    theme_color: "#059669",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
