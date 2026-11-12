using System.Diagnostics;

namespace ChanRemoteHost;

// ffmpeg 를 실행해 화면을 H.264 로 인코딩하고, 프레임(Access Unit) 단위로 쪼개서 넘겨줌.
// onFrame(data, isKeyframe) 가 프레임마다 호출됨.
public class ScreenEncoder
{
    readonly Config _cfg;
    readonly Action<byte[], bool> _onFrame;
    Process _proc;
    Thread _reader;
    volatile bool _stop;

    public byte[] LastKeyframe { get; private set; } // 새 접속자에게 즉시 보낼 최신 키프레임
    public event Action<string> Log;

    public ScreenEncoder(Config cfg, Action<byte[], bool> onFrame)
    {
        _cfg = cfg;
        _onFrame = onFrame;
    }

    public void Start()
    {
        string ffmpeg = _cfg.FfmpegPath;
        if (!File.Exists(ffmpeg))
        {
            string beside = Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe");
            if (File.Exists(beside)) ffmpeg = beside;
        }
        string args = _cfg.BuildFfmpegArgs();
        Log?.Invoke($"ffmpeg 실행: {ffmpeg} {args}");

        _proc = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = ffmpeg,
                Arguments = args,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };
        _proc.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Log?.Invoke("[ffmpeg] " + e.Data); };
        _proc.Start();
        _proc.BeginErrorReadLine();

        _reader = new Thread(ReadLoop) { IsBackground = true };
        _reader.Start();
    }

    void ReadLoop()
    {
        var stdout = _proc.StandardOutput.BaseStream;
        var splitter = new AnnexBSplitter((data, key) =>
        {
            if (key) LastKeyframe = data;
            _onFrame(data, key);
        });
        var buf = new byte[1 << 16];
        try
        {
            while (!_stop)
            {
                int n = stdout.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                splitter.Feed(buf, n);
            }
        }
        catch (Exception ex) { Log?.Invoke("읽기 종료: " + ex.Message); }
        if (!_stop) Log?.Invoke("ffmpeg 가 종료됐어요. (인코더/캡처 설정을 확인하세요)");
    }

    public void Stop()
    {
        _stop = true;
        try { if (_proc != null && !_proc.HasExited) _proc.Kill(true); } catch { }
    }
}

// H.264 Annex-B 스트림을 프레임(AU) 단위로 분리.
// ffmpeg 에 aud=insert 를 넣었기 때문에 AUD(NAL 타입 9)가 프레임의 시작 표시가 됨.
public class AnnexBSplitter
{
    readonly Action<byte[], bool> _emit;
    readonly List<byte> _au = new();     // 현재 모으는 프레임
    readonly List<byte> _pending = new(); // 아직 완성 안 된 꼬리
    bool _hasKey;

    public AnnexBSplitter(Action<byte[], bool> emit) => _emit = emit;

    public void Feed(byte[] data, int len)
    {
        for (int i = 0; i < len; i++) _pending.Add(data[i]);
        // 마지막 start code 전까지 처리하고, 꼬리는 남겨둠
        ProcessPending();
    }

    void ProcessPending()
    {
        var b = _pending;
        int i = 0;
        // start code 위치들을 찾아 NAL 단위로 처리
        int lastStart = -1;
        while (true)
        {
            int sc = FindStartCode(b, i);
            if (sc < 0) break;
            if (lastStart >= 0)
                HandleNal(b, lastStart, sc); // 이전 start~이번 start 직전까지가 한 NAL
            lastStart = sc;
            i = sc + 3;
        }
        // 남은 꼬리(마지막 start code 이후)는 다음 Feed 때 이어붙임
        if (lastStart > 0)
            b.RemoveRange(0, lastStart);
    }

    // start code(00 00 01) 시작 위치 반환 (4바이트 00 00 00 01도 뒤 3바이트가 잡힘)
    static int FindStartCode(List<byte> b, int from)
    {
        for (int i = Math.Max(0, from); i + 2 < b.Count; i++)
            if (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) return i;
        return -1;
    }

    void HandleNal(List<byte> b, int start, int end)
    {
        // NAL 타입 = start code(3) 다음 바이트의 하위 5비트
        int hdr = start + 3;
        if (hdr >= b.Count) return;
        int type = b[hdr] & 0x1F;

        // AUD(9) = 새 프레임 시작 → 지금까지 모은 프레임을 내보냄
        if (type == 9 && _au.Count > 0)
        {
            Flush();
        }
        // 4바이트 start code면 앞의 00 하나까지 포함해서 넣기
        int realStart = (start > 0 && b[start - 1] == 0) ? start - 1 : start;
        for (int i = realStart; i < end; i++) _au.Add(b[i]);
        if (type == 5 || type == 7) _hasKey = true; // IDR 또는 SPS 있으면 키프레임
    }

    void Flush()
    {
        if (_au.Count == 0) return;
        _emit(_au.ToArray(), _hasKey);
        _au.Clear();
        _hasKey = false;
    }
}
