import {describe,expect,it,vi} from "vitest";
import {assertRuntimeSubscriptionGuard} from "./subscriptionGuard.js";
describe("loaded subscription guard capability",()=>{
 it("requires an exact loaded guard acknowledgement",async()=>{const request=vi.fn(()=>Promise.resolve({version:1,runScopedFallbacks:true,readOnlyAdmission:true}));await assertRuntimeSubscriptionGuard({request});expect(request).toHaveBeenCalledWith("relay-channel.subscriptionGuard.status",{},{timeoutMs:3000});});
 it.each([null,{}, {version:1,runScopedFallbacks:true},{version:2,runScopedFallbacks:true,readOnlyAdmission:true}])("rejects missing/partial/unknown proof before authorization (%j)",async status=>{await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.resolve(status)})).rejects.toMatchObject({code:"OPENAI_POOL_GUARD_UPDATE_REQUIRED"});});
 it("normalizes missing method/offline errors without leaking payloads",async()=>{await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.reject(Error("private fixture contents"))})).rejects.toThrow("authorization did not install or change plugins");});
});
