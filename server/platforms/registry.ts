export interface PlatformDefinition {
  hxId: string;
  name: string;
  pid: string;
  upstreamSite: "primary" | "secondary";
  enabled: boolean;
  order: number;
}

export const platformRegistry: readonly PlatformDefinition[] = [
  { hxId: "HX-001", name: "Pornhub", pid: "PH", upstreamSite: "primary", enabled: true, order: 1 },
  { hxId: "HX-003", name: "TikTok", pid: "TT", upstreamSite: "primary", enabled: true, order: 2 },
  { hxId: "HX-021", name: "小红书", pid: "FBI", upstreamSite: "secondary", enabled: true, order: 3 },
  { hxId: "HX-009", name: "色虎", pid: "SH", upstreamSite: "primary", enabled: true, order: 4 },
  { hxId: "HX-024", name: "PH·Prem", pid: "BZMH", upstreamSite: "secondary", enabled: true, order: 5 },
  { hxId: "HX-035", name: "调教师", pid: "TJS", upstreamSite: "secondary", enabled: true, order: 6 },
  { hxId: "HX-016", name: "快播", pid: "KB", upstreamSite: "primary", enabled: true, order: 7 },
  { hxId: "HX-015", name: "黄片网盘", pid: "PD", upstreamSite: "primary", enabled: true, order: 8 },
  { hxId: "HX-006", name: "性欲社", pid: "HJ", upstreamSite: "primary", enabled: true, order: 9 },
  { hxId: "HX-004", name: "抖阴Pro", pid: "DYP", upstreamSite: "primary", enabled: true, order: 10 },
  { hxId: "HX-005", name: "抖阴Plus", pid: "DYS", upstreamSite: "primary", enabled: true, order: 11 },
  { hxId: "HX-026", name: "X-chat", pid: "YK", upstreamSite: "primary", enabled: true, order: 12 },
  { hxId: "HX-049", name: "白嫖社", pid: "BPS", upstreamSite: "secondary", enabled: true, order: 13 },
  { hxId: "HX-050", name: "好妻网", pid: "HQW", upstreamSite: "secondary", enabled: true, order: 14 },
  { hxId: "HX-022", name: "台姬店", pid: "TJD", upstreamSite: "secondary", enabled: true, order: 15 },
  { hxId: "HX-051", name: "魅魔vlog", pid: "MMV", upstreamSite: "secondary", enabled: true, order: 16 },
  { hxId: "HX-047", name: "稚嫩学园", pid: "AF", upstreamSite: "secondary", enabled: true, order: 17 },
  { hxId: "HX-018", name: "铁粉空间", pid: "TFKJ", upstreamSite: "secondary", enabled: true, order: 18 },
  { hxId: "HX-056", name: "精日头条", pid: "JRTT", upstreamSite: "secondary", enabled: true, order: 19 },
  { hxId: "HX-057", name: "91淫妻", pid: "YQ", upstreamSite: "secondary", enabled: true, order: 20 }
];

export function enabledSecondaryPlatformPids() {
  return platformRegistry
    .filter((platform) => platform.enabled && platform.upstreamSite === "secondary")
    .map((platform) => platform.pid);
}

export function getPlatformByPid(pid: string) {
  return platformRegistry.find((platform) => platform.pid === pid);
}
