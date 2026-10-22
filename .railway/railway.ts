import { defineRailway, project, service } from "railway/iac";

// Equivalent of railway.json for Infrastructure as Code.
// railway.json is still read until 2026-12-01. Do not apply this file while that
// file is still the service config. Before the cutoff: railway config plan, then
// railway config apply, from the deploy directory.
// Rename service() and project() to match LIVE_RAILWAY_SERVICE and LIVE_RAILWAY_PROJECT.
// No repository, volume, or variable values belong here.

export default defineRailway(() => {
  const live = service("live-mesh", {
    start: "node server.mjs",
    healthcheck: "/healthz",
    replicas: 1,
  });
  return project("live-board", {
    resources: [live],
  });
});
