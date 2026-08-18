import type { Metadata } from "next";
import DebriefGated from "@/components/DebriefGated";

export const metadata: Metadata = {
  title: "Morning Debrief | Magnet Monitor",
};

export default function DebriefPage() {
  return <DebriefGated />;
}
