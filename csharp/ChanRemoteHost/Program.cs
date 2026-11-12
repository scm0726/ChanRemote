using System.Net;
using System.Net.Sockets;
using ChanRemoteHost;

// ChanRemote (C# 네이티브 호스트) — 같은 와이파이용 프로토타입
// 화면을 ffmpeg(H.264 하드웨어 인코딩)로 캡처해서 브라우저(WebCodecs)로 보냄.

string baseDir = AppContext.BaseDirectory;
string cfgPath = Path.Combine(baseDir, "config.json");
var cfg = Config.Load(cfgPath);

string webRoot = Path.Combine(baseDir, "wwwroot");

void Log(string m) => Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {m}");

Console.OutputEncoding = System.Text.Encoding.UTF8;
Console.WriteLine("===== ChanRemote (C# 네이티브) =====");
Console.WriteLine($"인코더: {cfg.Encoder}  /  {cfg.Fps}fps  /  {cfg.BitrateMbps}Mbps");
Console.WriteLine($"설정 파일: {cfgPath}  (여기서 인코더/화질 변경)");

var server = new WebServer(cfg, webRoot);
server.Log += Log;

var encoder = new ScreenEncoder(cfg, (data, key) => server.Broadcast(data, key));
encoder.Log += Log;
server.AttachEncoder(encoder);

server.Start();
encoder.Start();

// 접속 주소 안내
Console.WriteLine();
Console.WriteLine("폰/다른 PC 브라우저(크롬)에서 아래 주소로 접속하세요:");
foreach (var ip in LocalIps())
    Console.WriteLine($"   http://{ip}:{cfg.Port}");
Console.WriteLine();
Console.WriteLine("종료하려면 이 창에서 Ctrl+C");

Console.CancelKeyPress += (_, e) => { encoder.Stop(); Environment.Exit(0); };
Thread.Sleep(Timeout.Infinite);

static IEnumerable<string> LocalIps()
{
    foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
    {
        if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
        foreach (var a in ni.GetIPProperties().UnicastAddresses)
            if (a.Address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a.Address))
                yield return a.Address.ToString();
    }
}
