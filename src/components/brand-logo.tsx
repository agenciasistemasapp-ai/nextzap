import logo from "@/assets/logo-nextzap.png.asset.json";
import { brand } from "@/config/brand";

export function BrandLogo({ className = "h-12" }: { className?: string }) {
  return <img src={logo.url} alt={brand.name} className={`w-auto object-contain ${className}`} />;
}
