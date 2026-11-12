using System.Runtime.InteropServices;

namespace ChanRemoteHost;

// 마우스·키보드 입력을 Windows에 주입 (SendInput).
// 마우스는 전체 가상 화면 기준 절대좌표(0~65535)로 움직여서 화면 배율·다중 모니터에 영향받지 않음.
public static class InputInjector
{
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] p, int size);
    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int n);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000, WHEEL = 0x0800, HWHEEL = 0x1000;
    const uint LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040;
    const uint KEYUP = 0x0002, UNICODE = 0x0004, KEYEVENTF_EXT = 0x0001;
    static readonly int Size = Marshal.SizeOf<INPUT>();

    // 가상 화면(모든 모니터 합친) 범위
    static int VX => GetSystemMetrics(76);
    static int VY => GetSystemMetrics(77);
    static int VW => Math.Max(1, GetSystemMetrics(78));
    static int VH => Math.Max(1, GetSystemMetrics(79));

    static int _ax, _ay; // 마지막 절대좌표 (클릭을 그 자리에서 하도록)

    static void Send(INPUT[] inputs) => SendInput((uint)inputs.Length, inputs, Size);

    static INPUT Mouse(uint flags, int dx = 0, int dy = 0, int data = 0) => new()
    {
        type = INPUT_MOUSE,
        U = new InputUnion { mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = (uint)data, dwFlags = flags } }
    };

    // nx, ny: 0~1 (화면 안의 위치). 지금은 주 모니터 기준.
    public static void MoveAbs(double nx, double ny)
    {
        nx = Math.Clamp(nx, 0, 1); ny = Math.Clamp(ny, 0, 1);
        // 주 모니터 영역을 가상 화면 기준 비율로 변환
        int pw = GetSystemMetrics(0), ph = GetSystemMetrics(1); // 주 모니터 크기
        double sx = (0 - VX + nx * pw) / VW;
        double sy = (0 - VY + ny * ph) / VH;
        _ax = (int)Math.Round(Math.Clamp(sx, 0, 1) * 65535);
        _ay = (int)Math.Round(Math.Clamp(sy, 0, 1) * 65535);
        Send(new[] { Mouse(MOVE | ABSOLUTE | VIRTUALDESK, _ax, _ay) });
    }

    public static void Button(int b, bool down)
    {
        uint f = b switch { 2 => down ? RDOWN : RUP, 1 => down ? MDOWN : MUP, _ => down ? LDOWN : LUP };
        Send(new[] { Mouse(f | MOVE | ABSOLUTE | VIRTUALDESK, _ax, _ay) });
    }

    public static void Wheel(int dy, int dx)
    {
        var list = new List<INPUT>();
        if (dy != 0) list.Add(Mouse(WHEEL, 0, 0, dy));
        if (dx != 0) list.Add(Mouse(HWHEEL, 0, 0, dx));
        if (list.Count > 0) Send(list.ToArray());
    }

    static bool Extended(ushort vk) =>
        vk is 0x21 or 0x22 or 0x23 or 0x24 or 0x25 or 0x26 or 0x27 or 0x28 or 0x2D or 0x2E or 0x5B or 0x5C or 0x5D or 0xA3 or 0xA5;

    public static void Key(ushort vk, bool down)
    {
        uint f = (down ? 0 : KEYUP) | (Extended(vk) ? KEYEVENTF_EXT : 0);
        Send(new[] { new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = f } } } });
    }

    public static void KeyPress(ushort vk) { Key(vk, true); Key(vk, false); }

    // 유니코드 글자(한글 포함)를 그대로 입력 — PC의 한/영 상태와 무관
    public static void Text(string s)
    {
        var list = new List<INPUT>();
        foreach (char ch in s)
        {
            if (ch == '\n') { KeyPress(0x0D); continue; }
            list.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = UNICODE } } });
            list.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = UNICODE | KEYUP } } });
        }
        if (list.Count > 0) Send(list.ToArray());
    }
}
