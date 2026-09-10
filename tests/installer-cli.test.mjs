/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Modified to verify marketplace-qualified installation ownership.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const INSTALLER = path.join(ROOT, "scripts", "installer-cli.mjs");

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-install-scope-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const codexDir = path.join(homeDir, "custom-codex");
  const catalog = path.join(homeDir, ".agents", "plugins", "marketplace.json");
  json(catalog, { name: "personal", plugins: [{ name: "cc", source: { source: "local", path: "./plugins/cc" } }] });
  json(path.join(homeDir, "plugins", "cc", "package.json"), { version: "1.0.0" });
  const server = path.join(homeDir, "fake-server.mjs");
  fs.writeFileSync(server, `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const dir = process.argv[2];
const catalog = process.argv[3];
fs.mkdirSync(dir, {recursive:true});
const configPath = path.join(dir,"config.toml");
const rootsPath = path.join(dir,"roots.json");
const logPath = path.join(dir,"rpc.jsonl");
const rl = readline.createInterface({input:process.stdin});
const readConfig = () => fs.existsSync(configPath) ? fs.readFileSync(configPath,"utf8") : "";
function removeSection(text,id) {
  const lines=text.split("\\n"); const kept=[]; let skip=false;
  for(const line of lines) {
    if(line.trim().startsWith("[")) skip = line.trim() === '[plugins."' + id + '"]';
    if(!skip) kept.push(line);
  }
  return kept.join("\\n");
}
rl.on("line", line => {
 const m=JSON.parse(line); fs.appendFileSync(logPath,JSON.stringify(m)+"\\n");
 let result={};
 if(m.method==="marketplace/add") result={installedRoot:path.dirname(path.dirname(path.dirname(catalog))),marketplaceName:"personal"};
 if(m.method==="plugin/install") {
   const c=JSON.parse(fs.readFileSync(m.params.marketplacePath,"utf8"));
   const item=c.plugins.find(x=>x.name===m.params.pluginName);
   const source=path.resolve(path.dirname(path.dirname(path.dirname(m.params.marketplacePath))),item.source.path);
   const target=path.join(dir,"plugins","cache",c.name,"cc","local");
   fs.rmSync(target,{recursive:true,force:true});fs.mkdirSync(path.dirname(target),{recursive:true});
   fs.cpSync(source,target,{recursive:true});
   const id="cc@"+c.name;
   fs.writeFileSync(configPath,removeSection(readConfig(),id)+'\\n[plugins."'+id+'"]\\nenabled = true\\n');
 }
 if(m.method==="plugin/uninstall") {
   const [plugin,marketplace]=m.params.pluginId.split("@");
   fs.rmSync(path.join(dir,"plugins","cache",marketplace,plugin),{recursive:true,force:true});
   fs.writeFileSync(configPath,removeSection(readConfig(),m.params.pluginId));
 }
 if(m.method==="config/read") result={
   config:{sandbox_workspace_write:{writable_roots:fs.existsSync(rootsPath)?JSON.parse(fs.readFileSync(rootsPath,"utf8")):[]}},
   origins:{},layers:[{name:{type:"user",file:configPath,profile:null},version:"fake-version",config:{}}]
 };
 if(m.method==="config/batchWrite") {
   const edit=m.params.edits.find(x=>x.keyPath==="sandbox_workspace_write.writable_roots");
   if(edit) fs.writeFileSync(rootsPath,JSON.stringify(edit.value));
   result={status:"ok"};
 }
 if(process.env.FAKE_RPC_FAILURE && m.method!=="initialize") {
   process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:"Synthetic unsupported method"}})+"\\n");return;
 }
 process.stdout.write(JSON.stringify({id:m.id,result})+"\\n");
});
`);
  const env = {
    ...process.env, HOME: homeDir, USERPROFILE: homeDir, CODEX_HOME: codexDir,
    CC_PLUGIN_CODEX_EXECUTABLE: process.execPath,
    CC_PLUGIN_CODEX_APP_SERVER_ARGS_JSON: JSON.stringify([server, codexDir, catalog]),
  };
  for (const key of ["CC_PLUGIN_CODEX_MARKETPLACE_SOURCE", "CC_PLUGIN_CODEX_MARKETPLACE_PATH", "CC_PLUGIN_CODEX_MARKETPLACE_NAME", "CC_PLUGIN_CODEX_MARKETPLACE_REF", "CC_PLUGIN_CODEX_MARKETPLACE_SPARSE_PATHS"]) delete env[key];
  return { homeDir, codexDir, catalog, env };
}

function run(f, command, extra = {}) {
  return spawnSync(process.execPath, [INSTALLER, command], {
    cwd: ROOT, env: { ...f.env, ...extra }, encoding: "utf8", timeout: 15000,
  });
}
function requests(f) {
  const file = path.join(f.codexDir, "rpc.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file,"utf8").trim().split("\n").map(JSON.parse) : [];
}

describe("marketplace-scoped installer", () => {
  it("installs the personal catalog without fetching another repository", t => {
    const f=fixture(t); const r=run(f,"install");
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,/Installed cc@personal/);
    const calls=requests(f);
    assert.equal(calls.filter(x=>x.method==="plugin/install").length,1);
    assert.equal(calls.some(x=>x.method==="marketplace/add"),false);
    assert.equal(fs.existsSync(path.join(f.codexDir,"plugins","cache","personal","cc","local","package.json")),true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.codexDir,"roots.json"),"utf8")),[path.join(f.codexDir,"plugins","data","cc-personal")]);
  });
  it("updates from the same catalog and retains saved jobs", t => {
    const f=fixture(t); assert.equal(run(f,"install").status,0);
    const state=path.join(f.codexDir,"plugins","data","cc-personal","state","saved.json");
    json(state,{result:"synthetic saved result"});
    json(path.join(f.homeDir,"plugins","cc","package.json"),{version:"2.0.0"});
    const r=run(f,"update"); assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.codexDir,"plugins","cache","personal","cc","local","package.json"),"utf8")).version,"2.0.0");
    assert.deepEqual(JSON.parse(fs.readFileSync(state,"utf8")),{result:"synthetic saved result"});
  });
  it("retains unrelated cc caches, legacy wrappers, catalog and user settings", t => {
    const f=fixture(t);
    const foreign=path.join(f.codexDir,"plugins","cache","sendbird","cc","1.5.0","keep.txt");
    fs.mkdirSync(path.dirname(foreign),{recursive:true});fs.writeFileSync(foreign,"keep");
    const wrapper=path.join(f.homeDir,".agents","skills","cc-review","SKILL.md");
    fs.mkdirSync(path.dirname(wrapper),{recursive:true});fs.writeFileSync(wrapper,"existing skill");
    const config=path.join(f.codexDir,"config.toml");
    fs.writeFileSync(config,'model = "fixture-model"\n[plugins."cc@sendbird"]\nenabled = true\n');
    const catalogBefore=fs.readFileSync(f.catalog,"utf8");
    const r=run(f,"install");assert.equal(r.status,0,r.stderr);
    assert.equal(fs.readFileSync(foreign,"utf8"),"keep");
    assert.equal(fs.readFileSync(wrapper,"utf8"),"existing skill");
    assert.equal(fs.readFileSync(f.catalog,"utf8"),catalogBefore);
    assert.match(fs.readFileSync(config,"utf8"),/cc@sendbird/);
    assert.match(fs.readFileSync(config,"utf8"),/fixture-model/);
  });
  it("uninstalls exactly one identity and preserves another installation and data", t => {
    const f=fixture(t);assert.equal(run(f,"install").status,0);
    const foreign=path.join(f.codexDir,"plugins","cache","sendbird","cc","keep");
    fs.mkdirSync(path.dirname(foreign),{recursive:true});fs.writeFileSync(foreign,"keep");
    const state=path.join(f.codexDir,"plugins","data","cc-personal","result.json");json(state,{saved:true});
    const before=requests(f).length;
    const r=run(f,"uninstall");assert.equal(r.status,0,r.stderr);
    const calls=requests(f).slice(before).filter(x=>x.method!=="initialize");
    assert.deepEqual(calls.map(x=>[x.method,x.params.pluginId]),[["plugin/uninstall","cc@personal"]]);
    assert.equal(fs.existsSync(foreign),true);assert.equal(fs.existsSync(state),true);assert.equal(fs.existsSync(f.catalog),true);
  });
  it("allows explicit qualified uninstall after the catalog is unavailable", t => {
    const f=fixture(t);fs.rmSync(f.catalog);
    const r=run(f,"uninstall",{CC_PLUGIN_CODEX_MARKETPLACE_NAME:"personal"});
    assert.equal(r.status,0,r.stderr);
    assert.equal(requests(f).find(x=>x.method==="plugin/uninstall").params.pluginId,"cc@personal");
  });
  it("does not change configuration when catalog is missing or mismatched", t => {
    const f=fixture(t);
    const wrong=run(f,"install",{CC_PLUGIN_CODEX_MARKETPLACE_NAME:"different"});
    assert.notEqual(wrong.status,0);assert.equal(requests(f).length,0);
    fs.rmSync(f.catalog);const missing=run(f,"install");
    assert.notEqual(missing.status,0);assert.match(missing.stderr,/Register this source/);
    assert.equal(fs.existsSync(path.join(f.codexDir,"config.toml")),false);
  });
  it("accepts an explicit catalog path and rejects ambiguous selectors", t => {
    const f=fixture(t);const moved=path.join(f.homeDir,"catalog.json");
    fs.copyFileSync(f.catalog,moved);
    // Catalog source paths resolve from marketplace root, so only inspect a failure
    // before install when selectors conflict.
    const r=run(f,"install",{CC_PLUGIN_CODEX_MARKETPLACE_PATH:moved,CC_PLUGIN_CODEX_MARKETPLACE_SOURCE:"fixture/source"});
    assert.notEqual(r.status,0);assert.equal(requests(f).length,0);
    assert.equal(run(f,"install",{CC_PLUGIN_CODEX_MARKETPLACE_PATH:f.catalog}).status,0);
  });
  it("registers a remote source only when explicitly selected", t => {
    const f=fixture(t);
    const r=run(f,"install",{CC_PLUGIN_CODEX_MARKETPLACE_SOURCE:"fixture/marketplace",CC_PLUGIN_CODEX_MARKETPLACE_NAME:"personal",CC_PLUGIN_CODEX_MARKETPLACE_REF:"pinned-ref",CC_PLUGIN_CODEX_MARKETPLACE_SPARSE_PATHS:"plugins/cc"});
    assert.equal(r.status,0,r.stderr);
    assert.deepEqual(requests(f).find(x=>x.method==="marketplace/add").params,{source:"fixture/marketplace",refName:"pinned-ref",sparsePaths:["plugins/cc"]});
  });
  it("propagates Codex install/uninstall failures without fallback cleanup", t => {
    const f=fixture(t);
    const r=run(f,"install",{FAKE_RPC_FAILURE:"1"});
    assert.notEqual(r.status,0);
    assert.equal(fs.existsSync(path.join(f.codexDir,"config.toml")),true); // Fake server performed install before its synthetic error.
    const u=run(f,"uninstall",{FAKE_RPC_FAILURE:"1"});
    assert.notEqual(u.status,0);
    assert.equal(fs.existsSync(f.catalog),true);
  });
  it("rejects malformed identities before any RPC", t => {
    const f=fixture(t);const r=run(f,"uninstall",{CC_PLUGIN_CODEX_MARKETPLACE_NAME:"bad/name"});
    assert.notEqual(r.status,0);assert.equal(requests(f).length,0);
  });
  it("POSIX convenience wrappers remain syntactically valid", () => {
    if(process.platform==="win32") return;
    for(const name of ["install.sh","uninstall.sh"]) {
      const result=spawnSync("bash",["-n",path.join(ROOT,"scripts",name)],{encoding:"utf8"});
      assert.equal(result.status,0,result.stderr);
    }
  });
});
