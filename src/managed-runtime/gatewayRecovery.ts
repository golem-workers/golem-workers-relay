/** Model/Gateway readiness must not gate relay ingress or management. */
export async function recoverGatewayConnection(input: {
  connect: () => Promise<void>;
  stopped: () => boolean;
  onError: (error: unknown) => void;
  wait?: () => Promise<void>;
}): Promise<void> {
  const wait = input.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 1_000)));
  while (!input.stopped()) {
    try { await input.connect(); return; }
    catch (error) {
      if (input.stopped()) return;
      input.onError(error);
      await wait();
    }
  }
}
