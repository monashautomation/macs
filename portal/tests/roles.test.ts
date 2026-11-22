import { describe, expect, it } from "vitest";
import { matchServiceKey, rolesForGroups, sha256Hex } from "@/lib/roles";

describe("rolesForGroups", () => {
  it("anyone signed in is a member when MEMBER_GROUPS is empty", () => {
    expect([...rolesForGroups([], ["admins"], [])]).toEqual(["member"]);
  });
  it("requires a member group when MEMBER_GROUPS is set", () => {
    expect(rolesForGroups(["other"], ["admins"], ["members"]).size).toBe(0);
    expect(rolesForGroups(["members"], ["admins"], ["members"]).has("member")).toBe(true);
  });
  it("admins are also members", () => {
    expect([...rolesForGroups(["admins"], ["admins"], ["members"])].sort()).toEqual(["admin", "member"]);
  });
  it("no admin groups configured means nobody is admin", () => {
    expect(rolesForGroups(["admins"], [], []).has("admin")).toBe(false);
  });
});

describe("matchServiceKey", () => {
  const keys = { discordbot: sha256Hex("key-one"), ledger: sha256Hex("key-two") };
  it("names the caller that owns the key", () => {
    expect(matchServiceKey("key-two", keys)).toBe("ledger");
  });
  it("rejects unknown and empty keys", () => {
    expect(matchServiceKey("nope", keys)).toBeNull();
    expect(matchServiceKey("", keys)).toBeNull();
  });
});
