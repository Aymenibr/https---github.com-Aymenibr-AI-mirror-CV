import { Suspense } from "react";

import PressPageClient from "./PressPageClient";

export default function PressPage() {
  return (
    <Suspense fallback={null}>
      <PressPageClient />
    </Suspense>
  );
}
