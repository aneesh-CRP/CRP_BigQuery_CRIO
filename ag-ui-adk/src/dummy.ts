
/**
 * Dummy Adapter to satisfy CopilotKit runtime requirements.
 * Used when the actual processing happens via custom middleware.
 */
export class DummyAdapter {
    process(request: any): any {
        console.log('[DummyAdapter] process() called with request:', JSON.stringify(request, null, 2));
        return {
            stream: new ReadableStream({
                start(controller) {
                    controller.close();
                }
            })
        };
    }
}
