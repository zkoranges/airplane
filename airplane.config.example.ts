import type { AirplaneConfig } from "./src/config";

const config: AirplaneConfig = {
  port: 4242,
  fixerIntervalMs: 5 * 60 * 1000,
  fixerTimeoutMs: 15 * 60 * 1000,
  repos: [
    // {
    //   name: "myrepo",
    //   path: "/Users/you/code/myrepo",
    //   defaultBranch: "main",
    //   paused: false,
    // },
  ],
};

export default config;
