"use client";

import Protected from "@/components/Protected";
import Dashboard from "./Dashboard";

export default function DashboardGated() {
  return (
    <Protected>{() => <Dashboard />}</Protected>
  );
}
