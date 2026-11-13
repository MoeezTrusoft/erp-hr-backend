package com.trusoft.attendance;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import java.net.*;
import java.net.http.*;
import java.util.Base64;
import static org.junit.jupiter.api.Assertions.*;

class AfisServiceTest {
    private JsonObject image(byte[] pixels) {
        var input = new JsonObject();
        input.addProperty("format", "GRAY8"); input.addProperty("width", 300);
        input.addProperty("height", 400); input.addProperty("dpi", 500);
        input.addProperty("imageBase64", Base64.getEncoder().encodeToString(pixels)); return input;
    }
    @Test void blankAndWrongResolutionFail() {
        var input = image(new byte[120000]);
        assertThrows(IllegalArgumentException.class, () -> AfisService.extract(input));
        input.addProperty("dpi", 1000);
        assertThrows(IllegalArgumentException.class, () -> AfisService.extract(input));
    }
    @Test void extractsAndMatchesSyntheticRidgesUsingRealEngine() {
        // Generated test pattern, not an employee's biometric. This proves wiring, not accuracy.
        byte[] pixels = new byte[120000];
        for (int y = 0; y < 400; y++) for (int x = 0; x < 300; x++) {
            double phase = Math.hypot(x - 150, (y - 160) * 0.7) * 0.7 + 0.3 * Math.sin(x * 0.07);
            boolean gap = (x / 35 + y / 47) % 5 == 0 && x % 35 < 8;
            pixels[y * 300 + x] = (byte) (gap ? 230 : 128 + 100 * Math.cos(phase));
        }
        String template = AfisService.extract(image(pixels));
        var input = new JsonObject(); input.addProperty("probe", template); input.addProperty("candidate", template); input.addProperty("engineVersion", AfisService.VERSION);
        assertTrue(AfisService.match(input) >= 40);
        input.addProperty("engineVersion", "different-version");
        assertThrows(IllegalArgumentException.class, () -> AfisService.match(input));
    }
    @Test void authenticatedHttpRejectsInvalidImagesWithoutLeakingData() throws Exception {
        String token = "test-token-012345678901234567890123456789";
        var service = new AfisService(token);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 4);
        server.createContext("/", service::handle); server.start();
        try (var client = HttpClient.newHttpClient()) {
            String url = "http://127.0.0.1:" + server.getAddress().getPort();
            assertEquals(401, client.send(HttpRequest.newBuilder(URI.create(url + "/healthz")).build(), HttpResponse.BodyHandlers.ofString()).statusCode());
            var health = client.send(HttpRequest.newBuilder(URI.create(url + "/healthz")).header("Authorization", "Bearer " + token).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(200, health.statusCode()); assertTrue(health.body().contains("NOT_PROVIDED"));
            var bad = client.send(HttpRequest.newBuilder(URI.create(url + "/extract")).header("Authorization", "Bearer " + token).POST(HttpRequest.BodyPublishers.ofString(image(new byte[120000]).toString())).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(422, bad.statusCode()); assertFalse(bad.body().contains("imageBase64"));
        } finally { server.stop(0); }
    }
}
