"use client";

import Protected from "@/components/Protected";
import Debrief from "./Debrief";

export default function DebriefGated() {
  return <Protected>{() => <Debrief />}</Protected>;
}
