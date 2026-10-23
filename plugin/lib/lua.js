// Builds the Lua snippets that run inside a clip's Fusion comp.
//
// Node layout the plugin keeps in a comp:
//   MediaIn -> [RampMeFlow] -> RampMe -> ...user nodes... -> [fx groups] -> MediaOut
// RampMe is a TimeStretcher (or FlowStretcher with RampMeFlow for optical flow)
// whose SourceTime spline holds the ramp. Effect groups sit right before
// MediaOut, each wrapped in RMfx_<gid>_In / RMfx_<gid>_Out pipe routers.

// Turns a JS value into a Lua literal. Arrays become 1-based tables.
function toLua(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Cannot pass ${v} to Lua`);
    return String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === 'string') {
    // Three-digit decimal escapes, so a digit after one is never read into it
    // ("\0341" is quote + "1"). Bytes above 127 (UTF-8) pass through.
    return `"${v.replace(/[\\"\x00-\x1f\x7f]/g, (c) => `\\${String(c.charCodeAt(0)).padStart(3, '0')}`)}"`;
  }
  if (Array.isArray(v)) return `{${v.map(toLua).join(',')}}`;
  if (typeof v === 'object') {
    return `{${Object.entries(v).map(([k, x]) => `[${toLua(k)}]=${toLua(x)}`).join(',')}}`;
  }
  throw new Error(`Cannot pass ${typeof v} to Lua`);
}

const PRELUDE = String.raw`
local RM = {}
function RM.json(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.10g", v)
  end
  if t == "string" then
    return '"' .. v:gsub('[%c"\\]', function(c)
      local m = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
      return m[c] or string.format("\\u%04x", c:byte())
    end) .. '"'
  end
  if t == "table" then
    local parts = {}
    if #v > 0 then
      for i = 1, #v do parts[i] = RM.json(v[i]) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    for k, x in pairs(v) do parts[#parts + 1] = RM.json(tostring(k)) .. ":" .. RM.json(x) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end
function RM.tools()
  local list = {}
  for _, t in pairs(comp:GetToolList(false)) do list[#list + 1] = t end
  return list
end
function RM.byReg(reg)
  for _, t in ipairs(RM.tools()) do
    if t:GetAttrs().TOOLS_RegID == reg then return t end
  end
end
function RM.source(tool, inputId)
  local inp = tool[inputId]
  local o = inp and inp:GetConnectedOutput()
  return o and o:GetTool()
end
-- Image inputs fed by tool's output, as { tool, inputId } pairs.
function RM.consumers(tool)
  local res = {}
  local name = tool:GetAttrs().TOOLS_Name
  for _, t in ipairs(RM.tools()) do
    for _, inp in pairs(t:GetInputList()) do
      local a = inp:GetAttrs()
      if a.INPS_DataType == "Image" then
        local o = inp:GetConnectedOutput()
        if o and o:GetTool():GetAttrs().TOOLS_Name == name then res[#res + 1] = { t, a.INPS_ID } end
      end
    end
  end
  return res
end
function RM.add(reg, name)
  local t = comp:AddTool(reg, -32768, -32768)
  if not t then error("Fusion has no tool " .. reg) end
  t:SetAttrs({ TOOLS_Name = name })
  return t
end
-- Deletes the loose PipeRouter the bridge adds from outside before each run.
function RM.sweep()
  for _, t in ipairs(RM.tools()) do
    local a = t:GetAttrs()
    if a.TOOLS_RegID == "PipeRouter" and not a.TOOLS_Name:match("^RMfx_") and
      not t.Input:GetConnectedOutput() and #RM.consumers(t) == 0 then
      t:Delete()
    end
  end
end
function RM.range()
  local a = comp:GetAttrs()
  return a.COMPN_RenderStart, a.COMPN_RenderEnd
end
`;

// Wraps a body so it runs under one undo step and reports back through comp data.
// The bridge polls RampMe.io for "<token>|ok|<json>" or "<token>|err|<message>".
// The script is compiled with loadstring so a syntax error comes back as an
// error message instead of the script silently never running.
function wrap(token, body) {
  const inner = `${PRELUDE}
local __ok, __res = pcall(function()
  comp:Lock()
  comp:StartUndo("Ramp Me")
  local ok, res = pcall(function()
RM.sweep()
${body}
  end)
  comp:EndUndo(true)
  comp:Unlock()
  if not ok then error(res, 0) end
  return res
end)
if __ok then
  comp:SetData("RampMe.io", ${toLua(token)} .. "|ok|" .. RM.json(__res))
else
  comp:SetData("RampMe.io", ${toLua(token)} .. "|err|" .. tostring(__res))
end
`;
  return `local __f, __e = loadstring(${toLua(inner)}, "RampMe")
if __f then __f() else comp:SetData("RampMe.io", ${toLua(token)} .. "|err|" .. tostring(__e)) end
`;
}

// Applies a ramp: samples are curve y values at evenly spaced x (0..1 over the
// comp's render range). Keyframes go on every frame (or every few frames for
// long clips) with linear interpolation, so the spline matches the editor.
function rampApply({ samples, mode, state }) {
  return `
local S = ${toLua(samples)}
local mode = ${toLua(mode)}
local want = (mode == "flow") and "Dimension.FlowStretcher" or "TimeStretcher"
local R0, R1 = RM.range()
local mi = RM.byReg("MediaIn")
if not mi then error("This clip's Fusion comp has no MediaIn") end
local rm, fl = comp:FindTool("RampMe"), comp:FindTool("RampMeFlow")
if (not rm) or rm:GetAttrs().TOOLS_RegID ~= want or ((mode == "flow") ~= (fl ~= nil)) then
  local cons = RM.consumers(rm or mi)
  local keep = {}
  for _, c in ipairs(cons) do
    local n = c[1]:GetAttrs().TOOLS_Name
    if n ~= "RampMe" and n ~= "RampMeFlow" then keep[#keep + 1] = c end
  end
  local spline = comp:FindTool("RampMeSourceTime")
  if rm then rm:Delete() end
  if fl then fl:Delete() end
  if spline then spline:Delete() end
  local src = mi
  if mode == "flow" then
    fl = RM.add("Dimension.OpticalFlow", "RampMeFlow")
    fl:ConnectInput("Input", mi)
    src = fl
  end
  rm = RM.add(want, "RampMe")
  rm:ConnectInput("Input", src)
  for _, c in ipairs(keep) do c[1]:ConnectInput(c[2], rm) end
  rm:AddModifier("SourceTime", "BezierSpline")
  rm.SourceTime:GetConnectedOutput():GetTool():SetAttrs({ TOOLS_Name = "RampMeSourceTime" })
end
rm.InterpolateBetweenFrames = (mode == "flow") and 2 or 0
local span = R1 - R0
local n = #S
local step = math.max(1, math.ceil(span / 1500))
local keys = {}
local f = R0
while true do
  local x = span > 0 and (f - R0) / span or 0
  local p = x * (n - 1) + 1
  local i = math.floor(p)
  local y = i >= n and S[n] or (S[i] + (S[i + 1] - S[i]) * (p - i))
  keys[f] = { R0 + y * span, Flags = { Linear = true } }
  if f >= R1 then break end
  f = math.min(R1, f + step)
end
rm.SourceTime:GetConnectedOutput():GetTool():SetKeyFrames(keys, true)
comp:SetData("RampMe.state", ${toLua(state)})
return { start = R0, finish = R1 }
`;
}

function rampClear() {
  return `
local mi = RM.byReg("MediaIn")
local rm, fl = comp:FindTool("RampMe"), comp:FindTool("RampMeFlow")
local spline = comp:FindTool("RampMeSourceTime")
if rm and mi then
  local cons = RM.consumers(rm)
  rm:Delete()
  for _, c in ipairs(cons) do c[1]:ConnectInput(c[2], mi) end
elseif rm then
  rm:Delete()
end
if fl then fl:Delete() end
if spline then spline:Delete() end
comp:SetData("RampMe.state", nil)
local left = 0
for _, t in ipairs(RM.tools()) do
  local reg = t:GetAttrs().TOOLS_RegID
  if reg ~= "MediaIn" and reg ~= "MediaOut" and reg ~= "AudioDisplay" then left = left + 1 end
end
return { empty = left == 0 }
`;
}

// Lua that rebuilds (or updates) one effect group.
// p: { gid, settings, itemStart, itemDuration, rangeStart, rangeEnd, data }
// settings: { blur, shake, warp, aberration, glow } as produced by the UI.
function fxApply(p) {
  return `
local P = ${toLua(p)}
local gid = P.gid
local pre = "RMfx_" .. gid .. "_"
local s = P.settings
local mo = RM.byReg("MediaOut")
if not mo then error("This clip's Fusion comp has no MediaOut") end
local R0, R1 = RM.range()

-- Comp frame -> timeline frame is linear (edit-page speed): t = start + (f - R0) / k.
local D = math.max(2, P.itemDuration)
local k = (R1 - R0) / (D - 1)
if k <= 0 then k = 1 end
local L = math.max(1, P.rangeEnd - 1 - P.rangeStart)
local a = 1 / (k * L)
local b = (P.itemStart - P.rangeStart) / L - R0 / (k * L)
local U = string.format("(time*%.12g+%.12g)", a, b)
local function env(peak)
  local inside = "iif(" .. U .. ">=0 and " .. U .. "<=1, %s, 0)"
  if peak == "start" then return string.format(inside, "(1-" .. U .. ")^2") end
  if peak == "end" then return string.format(inside, U .. "^2") end
  if peak == "full" then return string.format(inside, "1") end
  return string.format(inside, "sin(pi*" .. U .. ")^2")
end
local function expr(tool, input, amount, peak, base)
  tool[input]:SetExpression((base or "") .. string.format("%.6g*", amount) .. env(peak))
end

-- Find the groups already chained before MediaOut and the node feeding them.
local groups = {}
local base = RM.source(mo, "Input")
while base and base:GetAttrs().TOOLS_Name:match("^RMfx_%w+_Out$") do
  local g = base:GetAttrs().TOOLS_Name:match("^RMfx_(%w+)_Out$")
  local inT = comp:FindTool("RMfx_" .. g .. "_In")
  if g ~= gid then table.insert(groups, 1, g) end
  base = inT and RM.source(inT, "Input")
end

for _, t in ipairs(RM.tools()) do
  if t:GetAttrs().TOOLS_Name:sub(1, #pre) == pre then t:Delete() end
end

local any = (s.blur and s.blur.on) or (s.shake and s.shake.on) or (s.warp and s.warp.on) or
  (s.aberration and s.aberration.on) or (s.glow and s.glow.on)
if any then
  local gin = RM.add("PipeRouter", pre .. "In")
  local last = gin
  local function link(tool, input) tool:ConnectInput(input or "Input", last); last = tool end

  if s.shake and s.shake.on then
    local t = RM.add("CameraShake", pre .. "Shake")
    link(t)
    t.XDeviation = 0.05
    t.YDeviation = 0.05
    t.RotationDeviation = 0.12
    t.Speed = s.shake.frequency / 100
    t.Edges = 2
    t.MotionBlur = s.shake.blur and 1 or 0
    t.Quality = 4
    expr(t, "OverallStrength", s.shake.strength / 100, s.fxPeak)
  end
  if s.warp and s.warp.on then
    local t = RM.add("LensDistort", pre .. "Warp")
    link(t)
    -- Positive distortion pushes the picture outward; negative shrinks it and
    -- leaves black corners that no edge mode fills.
    expr(t, "DEClassicLDModel.Distortion", 0.3 * math.max(0, s.warp.strength) / 100, s.fxPeak)
  end
  if s.aberration and s.aberration.on then
    local amt = 0.03 * s.aberration.strength / 100
    local src = last
    local up = RM.add("Transform", pre .. "AbRed")
    up:ConnectInput("Input", src)
    up.Edges = 2
    expr(up, "Size", amt, s.fxPeak, "1+")
    local down = RM.add("Transform", pre .. "AbBlue")
    down:ConnectInput("Input", src)
    down.Edges = 2
    expr(down, "Size", amt, s.fxPeak, "1-")
    local red = RM.add("ChannelBoolean", pre .. "AbMixR")
    red:ConnectInput("Background", src)
    red:ConnectInput("Foreground", up)
    red.ToRed, red.ToGreen, red.ToBlue, red.ToAlpha = 0, 6, 7, 8
    local blue = RM.add("ChannelBoolean", pre .. "AbMixB")
    blue:ConnectInput("Background", red)
    blue:ConnectInput("Foreground", down)
    blue.ToRed, blue.ToGreen, blue.ToBlue, blue.ToAlpha = 5, 6, 2, 8
    last = blue
  end
  if s.glow and s.glow.on then
    local t = RM.add("SoftGlow", pre .. "Glow")
    link(t)
    t.Threshold = 0.55
    t.Gain = 2.5
    t.XGlowSize = 4 + s.glow.size * 0.36
    expr(t, "Blend", s.glow.strength / 100, s.fxPeak)
  end
  if s.blur and s.blur.on then
    local t = RM.add("DirectionalBlur", pre .. "Blur")
    link(t)
    local zoom = s.blur.type == "zoom"
    t.Type = zoom and 3 or 0
    t.Center = { s.blur.center[1], s.blur.center[2] }
    t.Angle = s.blur.angle
    expr(t, "Length", (zoom and 0.4 or 0.25) * s.blur.strength / 100, s.blurPeak)
  end

  local gout = RM.add("PipeRouter", pre .. "Out")
  link(gout)
  groups[#groups + 1] = gid
  comp:SetData("RampMe.fx." .. gid, P.data)
else
  comp:SetData("RampMe.fx." .. gid, nil)
end

local prev = base
for _, g in ipairs(groups) do
  local inT, outT = comp:FindTool("RMfx_" .. g .. "_In"), comp:FindTool("RMfx_" .. g .. "_Out")
  if inT and outT then
    if prev then inT:ConnectInput("Input", prev) end
    prev = outT
  end
end
if prev then mo:ConnectInput("Input", prev) end
return { groups = groups }
`;
}

module.exports = { toLua, wrap, rampApply, rampClear, fxApply, PRELUDE };
