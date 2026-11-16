import {describe,expect,it,vi} from "vitest";
import {assertRuntimeSubscriptionGuard} from "./subscriptionGuard.js";
describe("loaded subscription guard capability",()=>{
 it("requires an exact loaded guard acknowledgement",async()=>{const request=vi.fn(()=>Promise.resolve({version:1,runScopedFallbacks:true,readOnlyAdmission:true}));expect(await assertRuntimeSubscriptionGuard({request})).toEqual({runScopedFallbacks:true});expect(request).toHaveBeenCalledWith("relay-channel.subscriptionGuard.status",{},{timeoutMs:3000});});
 it.each([null,{}, {version:1,runScopedFallbacks:true},{version:2,runScopedFallbacks:true,readOnlyAdmission:true}])("rejects missing/partial/unknown proof before authorization (%j)",async status=>{await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.resolve(status)})).rejects.toMatchObject({code:"OPENAI_POOL_GUARD_UPDATE_REQUIRED"});});
 it("accepts explicit 9.8 strict proof without claiming run-scoped suppression",async()=>{await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.resolve({version:2,runScopedFallbacks:false,configuredFallbacksForbidden:true,readOnlyAdmission:true})})).resolves.toEqual({runScopedFallbacks:false});});
 it.each([{version:2,runScopedFallbacks:false,readOnlyAdmission:true},{version:2,runScopedFallbacks:true,configuredFallbacksForbidden:true,readOnlyAdmission:true},{version:3,runScopedFallbacks:false,configuredFallbacksForbidden:true,readOnlyAdmission:true}])("rejects ambiguous legacy proof %j",async status=>{await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.resolve(status)})).rejects.toMatchObject({code:"OPENAI_POOL_GUARD_UPDATE_REQUIRED"});});
 it("normalizes missing method/offline errors without leaking payloads",async()=>{await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.reject(Error("private fixture contents"))})).rejects.toThrow("authorization did not install or change plugins");});
});

it("requires explicit loaded plugin exit support before advertising or beginning exit", async () => {
 const old = {version:2,runScopedFallbacks:false,configuredFallbacksForbidden:true,readOnlyAdmission:true};
 await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.resolve(old)}, true)).rejects.toMatchObject({code:"OPENAI_POOL_GUARD_UPDATE_REQUIRED"});
 await expect(assertRuntimeSubscriptionGuard({request:()=>Promise.resolve({...old,poolExitVersion:1})}, true)).resolves.toEqual({runScopedFallbacks:false});
});
