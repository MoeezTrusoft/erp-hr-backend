package com.trusoft.attendance;

import com.google.gson.*;
import com.machinezoo.sourceafis.*;
import com.sun.net.httpserver.*;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.*;

/** Private recognition service. SourceAFIS does not provide liveness detection. */
public final class AfisService {
    static final String VERSION = "sourceafis-java-3.18.1-gray8-500dpi-v1";
    private static final int MAX_BODY = 3 * 1024 * 1024;
    private static final Gson JSON = new GsonBuilder().setStrictness(Strictness.STRICT).create();
    private final Semaphore gate = new Semaphore(2);
    private final byte[] authorization;

    AfisService(String token) {
        if (token == null || token.length() < 32) throw new IllegalArgumentException("Set BIOMETRIC_ENGINE_TOKEN (at least 32 characters)");
        authorization = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
    }
    public static void main(String[] args) throws IOException {
        // Bound slow requests and queued work. Bind locally; use a TLS proxy for remote deployment.
        System.setProperty("sun.net.httpserver.maxReqTime", "20");
        System.setProperty("sun.net.httpserver.maxRspTime", "20");
        var service = new AfisService(System.getenv("BIOMETRIC_ENGINE_TOKEN"));
        int port = Integer.parseInt(System.getenv().getOrDefault("SOURCEAFIS_PORT", "8092"));
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 16);
        var executor = new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16), new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(executor);
        server.createContext("/", service::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> { server.stop(1); executor.shutdown(); }));
        server.start();
        System.out.println("SourceAFIS ready on loopback port " + port);
    }
    void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            var supplied = exchange.getRequestHeaders().getFirst("Authorization");
            if (supplied == null || !MessageDigest.isEqual(authorization, supplied.getBytes(StandardCharsets.UTF_8))) {
                respond(exchange, 401, Map.of("error", "Authentication required")); return;
            }
            if (!gate.tryAcquire()) { respond(exchange, 429, Map.of("error", "Recognition is busy; retry")); return; }
            try {
                String path = exchange.getRequestURI().getPath();
                if (path.equals("/healthz") && exchange.getRequestMethod().equals("GET")) {
                    respond(exchange, 200, Map.of("ready", true, "engine", "SOURCEAFIS", "engineVersion", VERSION, "pad", "NOT_PROVIDED")); return;
                }
                if (!exchange.getRequestMethod().equals("POST") || !(path.equals("/extract") || path.equals("/match"))) {
                    respond(exchange, 404, Map.of("error", "Unknown operation")); return;
                }
                byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
                if (body.length > MAX_BODY) { respond(exchange, 413, Map.of("error", "Request too large")); return; }
                JsonObject input = JSON.fromJson(new String(body, StandardCharsets.UTF_8), JsonObject.class);
                if (input == null) throw new IllegalArgumentException();
                Object result = path.equals("/extract")
                    ? Map.of("engine", "SOURCEAFIS", "engineVersion", VERSION, "template", extract(input))
                    : Map.of("engine", "SOURCEAFIS", "engineVersion", VERSION, "score", match(input));
                respond(exchange, 200, result);
            } catch (IllegalArgumentException | IllegalStateException | JsonParseException ex) {
                respond(exchange, 422, Map.of("error", "Sample or template rejected"));
            } catch (RuntimeException ex) {
                // Never log request bodies, raw images, templates, or exception details.
                respond(exchange, 503, Map.of("error", "Recognition unavailable"));
            } finally { gate.release(); }
        }
    }
    private static void respond(HttpExchange exchange, int status, Object data) throws IOException {
        byte[] bytes = JSON.toJson(data).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
    private static String string(JsonObject input, String key) {
        var value = input.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException();
        return value.getAsString();
    }
    private static int integer(JsonObject input, String key) {
        var value = input.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException();
        return value.getAsBigDecimal().intValueExact();
    }
    static String extract(JsonObject input) {
        if (!string(input, "format").equals("GRAY8") || integer(input, "width") != 300 || integer(input, "height") != 400 || integer(input, "dpi") != 500) throw new IllegalArgumentException();
        String encoded = string(input, "imageBase64");
        if (encoded.length() != 160000) throw new IllegalArgumentException();
        byte[] pixels = Base64.getDecoder().decode(encoded);
        if (pixels.length != 120000) throw new IllegalArgumentException();
        double sum = 0, squares = 0;
        for (byte pixel : pixels) { double value = Byte.toUnsignedInt(pixel); sum += value; squares += value * value; }
        double mean = sum / pixels.length;
        if (squares / pixels.length - mean * mean < 100) throw new IllegalArgumentException();
        var template = new FingerprintTemplate(new FingerprintImage(300, 400, pixels, new FingerprintImageOptions().dpi(500)));
        // Empty or insufficient feature sets must not be enrolled.
        if (new FingerprintMatcher(template).match(template) < 40) throw new IllegalArgumentException();
        return Base64.getEncoder().encodeToString(template.toByteArray());
    }
    private static FingerprintTemplate template(String encoded) {
        if (encoded.isEmpty() || encoded.length() > 700000) throw new IllegalArgumentException();
        return new FingerprintTemplate(Base64.getDecoder().decode(encoded));
    }
    static double match(JsonObject input) {
        if (!string(input, "engineVersion").equals(VERSION)) throw new IllegalArgumentException();
        double score = new FingerprintMatcher(template(string(input, "probe"))).match(template(string(input, "candidate")));
        if (!Double.isFinite(score) || score < 0) throw new IllegalArgumentException();
        return score;
    }
}
