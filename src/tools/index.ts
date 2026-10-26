// Side-effect-only barrel: importing this module triggers every tool
// module's self-registration into the ToolRegistry. index.ts imports only
// this file, so adding a new tool module means adding one line here.
import "./dashboard.js";
import "./datasets.js";
import "./attacks.js";
import "./configuration.js";
import "./experiments.js";
import "./analysis.js";
import "./generation.js";
import "./admin.js";
