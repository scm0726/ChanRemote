using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ChanRemoteHost;

// 간단한 HTTP + WebSocket 서버 (관리자 권한 불필요 — TcpListener 사용).
// - 브라우저에 wwwroot 의 웹 뷰어를 제공
// - /ws 로 접속하면: 서버→클라이언트 H.264 프레임(바이너리), 클라이언트→서버 입력(JSON 텍스트)
public class WebServer
{
    readonly Config _cfg;
    readonly string _webRoot;
    readonly List<WsClient> _clients = new();
    readonly object _lock = new();
    TcpListener _listener;
    ScreenEncoder _encoder;
    public event Action<string> Log;

    public WebServer(Config cfg, string webRoot)
    {
        _cfg = cfg;
        _webRoot = webRoot;
    }

    public void AttachEncoder(ScreenEncoder enc) => _encoder = enc;

    // 인코더가 프레임을 만들 때마다 호출 → 모든 접속자에게 전송
    public void Broadcast(byte[] frame, bool key)
    {
        lock (_lock)
            foreach (var c in _clients) c.Enqueue(frame, key);
    }

    public void Start()
    {
        _listener = new TcpListener(IPAddress.Any, _cfg.Port);
        _listener.Start();
        Log?.Invoke($"접속 서버 시작: 포트 {_cfg.Port}");
        new Thread(AcceptLoop) { IsBackground = true }.Start();
    }

    void AcceptLoop()
    {
        while (true)
        {
            TcpClient tcp;
            try { tcp = _listener.AcceptTcpClient(); }
            catch { break; }
            new Thread(() => Handle(tcp)) { IsBackground = true }.Start();
        }
    }

    void Handle(TcpClient tcp)
    {
        try
        {
            tcp.NoDelay = true;
            var stream = tcp.GetStream();
            string req = ReadHeader(stream);
            if (req == null) { tcp.Close(); return; }

            string path = req.Split(' ').Skip(1).FirstOrDefault() ?? "/";
            if (req.Contains("Upgrade: websocket", StringComparison.OrdinalIgnoreCase)
                || req.Contains("upgrade: websocket", StringComparison.OrdinalIgnoreCase))
            {
                DoWebSocket(tcp, stream, req);
            }
            else
            {
                ServeFile(stream, path.Split('?')[0]);
                tcp.Close();
            }
        }
        catch (Exception ex) { Log?.Invoke("연결 처리 오류: " + ex.Message); try { tcp.Close(); } catch { } }
    }

    static string ReadHeader(NetworkStream s)
    {
        var sb = new StringBuilder();
        var one = new byte[1];
        int zeroStreak = 0;
        while (sb.Length < 16384)
        {
            int n = s.Read(one, 0, 1);
            if (n <= 0) return null;
            sb.Append((char)one[0]);
            if (one[0] == '\n' && sb.ToString().EndsWith("\r\n\r\n")) break;
            if (one[0] == '\n') { if (++zeroStreak > 200) break; }
        }
        return sb.ToString();
    }

    // ── 정적 파일 제공 ──
    void ServeFile(NetworkStream s, string path)
    {
        if (path == "/" || path == "") path = "/index.html";
        string full = Path.GetFullPath(Path.Combine(_webRoot, path.TrimStart('/')));
        if (!full.StartsWith(Path.GetFullPath(_webRoot)) || !File.Exists(full))
        {
            byte[] nf = Encoding.UTF8.GetBytes("not found");
            WriteHttp(s, "404 Not Found", "text/plain", nf);
            return;
        }
        string mime = Path.GetExtension(full).ToLowerInvariant() switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json",
            ".png" => "image/png",
            _ => "application/octet-stream"
        };
        WriteHttp(s, "200 OK", mime, File.ReadAllBytes(full));
    }

    static void WriteHttp(NetworkStream s, string status, string mime, byte[] body)
    {
        string head = $"HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {body.Length}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
        byte[] h = Encoding.ASCII.GetBytes(head);
        s.Write(h, 0, h.Length);
        s.Write(body, 0, body.Length);
    }

    // ── WebSocket ──
    void DoWebSocket(TcpClient tcp, NetworkStream s, string req)
    {
        string key = null;
        foreach (var line in req.Split("\r\n"))
            if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                key = line.Split(':', 2)[1].Trim();
        if (key == null) { tcp.Close(); return; }

        string accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        string resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n";
        byte[] r = Encoding.ASCII.GetBytes(resp);
        s.Write(r, 0, r.Length);

        var client = new WsClient(tcp, s);
        lock (_lock) _clients.Add(client);
        Log?.Invoke($"접속: {tcp.Client.RemoteEndPoint}");

        // 접속하자마자 최신 키프레임을 보내 바로 화면이 뜨게
        if (_encoder?.LastKeyframe != null) client.Enqueue(_encoder.LastKeyframe, true);

        client.SenderLoop(); // 전송은 이 스레드에서
        try { ReceiveLoop(client); } catch { }

        lock (_lock) _clients.Remove(client);
        client.Close();
        Log?.Invoke($"접속 종료: {tcp.Client.RemoteEndPoint}");
    }

    // 클라이언트 → 서버 (입력 JSON)
    void ReceiveLoop(WsClient c)
    {
        while (true)
        {
            string msg = c.ReadText();
            if (msg == null) break;
            HandleInput(msg);
        }
    }

    void HandleInput(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var e = doc.RootElement;
            string t = e.GetProperty("t").GetString();
            switch (t)
            {
                case "mm": InputInjector.MoveAbs(GetD(e, "x"), GetD(e, "y")); break;
                case "mb":
                    if (e.TryGetProperty("x", out _)) InputInjector.MoveAbs(GetD(e, "x"), GetD(e, "y"));
                    InputInjector.Button(GetI(e, "b"), e.GetProperty("down").GetBoolean());
                    break;
                case "wh": InputInjector.Wheel(GetI(e, "dy"), GetI(e, "dx")); break;
                case "k": InputInjector.Key((ushort)GetI(e, "vk"), e.GetProperty("down").GetBoolean()); break;
                case "kp": InputInjector.KeyPress((ushort)GetI(e, "vk")); break;
                case "txt": InputInjector.Text(e.GetProperty("s").GetString() ?? ""); break;
            }
        }
        catch { }
    }

    static double GetD(JsonElement e, string k) => e.TryGetProperty(k, out var v) ? v.GetDouble() : 0;
    static int GetI(JsonElement e, string k) => e.TryGetProperty(k, out var v) ? v.GetInt32() : 0;
}
