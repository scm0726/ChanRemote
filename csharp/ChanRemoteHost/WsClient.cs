using System.Net.Sockets;
using System.Text;

namespace ChanRemoteHost;

// WebSocket 한 명 담당: 영상 프레임 전송(바이너리) + 입력 수신(텍스트).
// 네트워크가 느려 밀리면 오래된 프레임은 버리고 다음 키프레임부터 다시 보냄(끊김 최소화).
public class WsClient
{
    readonly TcpClient _tcp;
    readonly NetworkStream _s;
    readonly Queue<(byte[] data, bool key)> _q = new();
    readonly object _qlock = new();
    bool _needKey = true;   // 처음엔 키프레임부터
    bool _closed;
    const int MaxBacklog = 60;

    public WsClient(TcpClient tcp, NetworkStream s) { _tcp = tcp; _s = s; }

    public void Enqueue(byte[] frame, bool key)
    {
        lock (_qlock)
        {
            if (_needKey)
            {
                if (!key) return;      // 키프레임 올 때까지 대기
                _q.Clear();
                _needKey = false;
            }
            _q.Enqueue((frame, key));
            if (_q.Count > MaxBacklog) { _q.Clear(); _needKey = true; } // 너무 밀리면 리셋
            Monitor.Pulse(_qlock);
        }
    }

    public void SenderLoop()
    {
        new Thread(() =>
        {
            try
            {
                while (!_closed)
                {
                    (byte[] data, bool key) item;
                    lock (_qlock)
                    {
                        while (_q.Count == 0 && !_closed) Monitor.Wait(_qlock, 1000);
                        if (_closed) return;
                        if (_q.Count == 0) continue;
                        item = _q.Dequeue();
                    }
                    WriteFrame(2, item.data); // 2 = binary
                }
            }
            catch { Close(); }
        }) { IsBackground = true }.Start();
    }

    // ── 전송 프레임(서버→클라, 마스킹 없음) ──
    void WriteFrame(byte opcode, byte[] payload)
    {
        var header = new List<byte> { (byte)(0x80 | opcode) };
        int len = payload.Length;
        if (len < 126) header.Add((byte)len);
        else if (len < 65536) { header.Add(126); header.Add((byte)(len >> 8)); header.Add((byte)len); }
        else
        {
            header.Add(127);
            for (int i = 7; i >= 0; i--) header.Add((byte)((long)len >> (8 * i)));
        }
        lock (_s)
        {
            _s.Write(header.ToArray(), 0, header.Count);
            _s.Write(payload, 0, payload.Length);
        }
    }

    // ── 수신 프레임(클라→서버, 마스킹 있음) ──
    public string ReadText()
    {
        while (true)
        {
            int b0 = _s.ReadByte(), b1 = _s.ReadByte();
            if (b0 < 0 || b1 < 0) return null;
            int opcode = b0 & 0x0F;
            bool masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7F;
            if (len == 126) len = (ReadByte() << 8) | ReadByte();
            else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | (uint)ReadByte(); }

            byte[] mask = new byte[4];
            if (masked) for (int i = 0; i < 4; i++) mask[i] = (byte)ReadByte();

            byte[] payload = new byte[len];
            int read = 0;
            while (read < len)
            {
                int n = _s.Read(payload, read, (int)(len - read));
                if (n <= 0) return null;
                read += n;
            }
            if (masked) for (int i = 0; i < len; i++) payload[i] ^= mask[i & 3];

            if (opcode == 8) return null;          // close
            if (opcode == 9) { WriteFrame(10, payload); continue; } // ping → pong
            if (opcode == 1) return Encoding.UTF8.GetString(payload); // text
            // 그 외(바이너리/연속)는 무시하고 계속
        }
    }

    int ReadByte()
    {
        int b = _s.ReadByte();
        if (b < 0) throw new IOException("closed");
        return b;
    }

    public void Close()
    {
        _closed = true;
        lock (_qlock) Monitor.PulseAll(_qlock);
        try { _tcp.Close(); } catch { }
    }
}
