import { useEffect, useState } from "react";

const PHONE_VIEWPORT_QUERY = "(max-width: 600px)";

function matchesPhoneViewport(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

export function usePhoneViewport(): boolean {
  const [phoneViewport, setPhoneViewport] = useState(matchesPhoneViewport);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const update = () => setPhoneViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return phoneViewport;
}
