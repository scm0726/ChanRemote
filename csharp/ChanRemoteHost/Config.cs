using System.Text.Json;

namespace ChanRemoteHost;

// 설정 — 처음 실행하면 실행 파일 옆에 config.json 이 자동으로 만들어져요.
// 그 파일을 메모장으로 열어 ffmpeg 경로나 인코더를 바꾸면 돼요.
public class Config
{
    // 접속 포트 (브라우저에서 http://PC주소:포트 로 접속)
    public int Port { get; set; } = 8787;

    // ffmpeg.exe 경로. 비워두면 실행 파일 옆의 ffmpeg.exe 를 찾음.
    public string FfmpegPath { get; set; } = "ffmpeg.exe";

    // 인코더 프리셋 선택: "cpu"(어디서나 동작), "nvidia", "intel", "amd"
    // 성능은 GPU(nvidia/intel/amd)가 훨씬 좋아요. 내 PC 그래픽에 맞는 걸로 바꾸세요.
    public string Encoder { get; set; } = "cpu";

    // 프레임레이트 / 화질(비트레이트, Mbps)
    public int Fps { get; set; } = 30;
    public int BitrateMbps { get; set; } = 12;

    // 접속 비밀번호 (간단 버전). 비우면 누구나 접속 가능.
    public string Password { get; set; } = "";

    public static Config Load(string path)
    {
        try
        {
            if (File.Exists(path))
                return JsonSerializer.Deserialize<Config>(File.ReadAllText(path)) ?? new Config();
        }
        catch { /* 형식 오류면 기본값 */ }
        var c = new Config();
        c.Save(path);
        return c;
    }

    public void Save(string path)
    {
        try { File.WriteAllText(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true })); }
        catch { }
    }

    // 선택한 인코더에 맞는 ffmpeg 인자 만들기.
    // 캡처: ddagrab(GPU, 빠름) / gdigrab(CPU, 어디서나). 인코딩: nvenc/qsv/amf/libx264.
    // dump_extra = 키프레임 앞에 SPS/PPS 삽입, h264_metadata=aud=insert = 프레임 경계 표시(AUD).
    public string BuildFfmpegArgs()
    {
        int kbps = BitrateMbps * 1000;
        int gop = Fps * 2; // 2초마다 키프레임
        string common = $"-g {gop} -bf 0 -bsf:v dump_extra,h264_metadata=aud=insert -f h264 -loglevel warning -";

        switch (Encoder.ToLowerInvariant())
        {
            case "nvidia":
                // NVIDIA GPU: 화면 캡처부터 인코딩까지 전부 GPU에서 (가장 빠름, 저지연)
                return $"-filter_complex ddagrab=framerate={Fps} -c:v h264_nvenc -preset p1 -tune ll -rc cbr -b:v {kbps}k -forced-idr 1 {common}";
            case "intel":
                return $"-filter_complex ddagrab=framerate={Fps},hwmap=derive_device=qsv,format=qsv -c:v h264_qsv -preset veryfast -b:v {kbps}k {common}";
            case "amd":
                return $"-filter_complex ddagrab=framerate={Fps},hwdownload,format=bgra -c:v h264_amf -usage lowlatency -rc cbr -b:v {kbps}k {common}";
            default:
                // CPU: 어디서나 동작. ultrafast + zerolatency 로 지연 최소화.
                return $"-f gdigrab -framerate {Fps} -i desktop -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v {kbps}k {common}";
        }
    }
}
