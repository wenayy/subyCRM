import { Suspense } from "react";
import { InboxView } from "./inbox-view";

export default function Page() {
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
