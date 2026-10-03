using System.Diagnostics;
using System.Text.RegularExpressions;

ApplicationConfiguration.Initialize();
Application.Run(new ControlForm());

sealed class ControlForm : Form
{
    readonly Label web = new() { AutoSize = true };
    readonly Label db = new() { AutoSize = true };
    const string PgService = "postgresql-x64-18";
    const string LocalWebUrl = "http://127.0.0.1:3000/";

    public ControlForm()
    {
        Text = "ワークマンアプリ Web／DB管理";
        ClientSize = new Size(580, 310);
        BackColor = Color.White;
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(24), AutoScroll = true };
        panel.Controls.Add(new Label { Text = "ワークマンアプリ サービス管理", Font = new Font("Yu Gothic UI", 16, FontStyle.Bold), AutoSize = true });
        panel.Controls.Add(MakeGroup("Webサーバー", "接続先: 127.0.0.1 / Port: 3000（このPC内のみ）", web, StartWeb, StopWeb));
        panel.Controls.Add(MakeGroup("PostgreSQL DB", "接続先: 127.0.0.1 / Port: 5432（外部公開なし）", db, () => ControlDb("start"), () => ControlDb("stop")));
        var refresh = new Button { Text = "状態を更新", Width = 180, Height = 42 };
        refresh.Click += (_, _) => RefreshState();
        panel.Controls.Add(refresh);
        Controls.Add(panel);
        Shown += (_, _) => RefreshState();
    }

    Control MakeGroup(string title, string address, Label state, Action start, Action stop)
    {
        var group = new GroupBox { Text = title, Width = 520, Height = 100, Padding = new Padding(12) };
        var addressLabel = new Label { Text = address, Location = new Point(14, 24), AutoSize = true };
        state.Location = new Point(14, 50);
        var on = new Button { Text = "起動", Location = new Point(330, 23), Size = new Size(75, 42) };
        var off = new Button { Text = "停止", Location = new Point(415, 23), Size = new Size(75, 42) };
        on.Click += (_, _) => { start(); RefreshState(); };
        off.Click += (_, _) => { stop(); RefreshState(); };
        group.Controls.AddRange([addressLabel, state, on, off]);
        return group;
    }

    void StartWeb()
    {
        if (IsWebUp()) return;
        Process.Start(new ProcessStartInfo { FileName = "node", Arguments = "server.mjs", WorkingDirectory = FindRoot(), UseShellExecute = false, CreateNoWindow = true });
    }

    void StopWeb()
    {
        var processId = GetNodeProcessOnWebPort();
        if (processId is not int id) return;
        try { Process.GetProcessById(id).Kill(true); } catch { }
    }

    void ControlDb(string action) => Run("sc.exe", $"{action} {PgService}");

    void RefreshState()
    {
        web.Text = "状態: " + (IsWebUp() ? "稼働中" : "停止中");
        db.Text = "状態: " + (IsDbUp() ? "稼働中" : "停止中");
    }

    static bool IsDbUp() => Run("sc.exe", $"query {PgService}").Output.Contains("RUNNING");

    static bool IsWebUp()
    {
        try { using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) }; return client.GetAsync(LocalWebUrl).GetAwaiter().GetResult().IsSuccessStatusCode; }
        catch { return false; }
    }

    static int? GetNodeProcessOnWebPort()
    {
        var output = Run("netstat.exe", "-ano -p tcp").Output;
        var match = Regex.Match(output, @"^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0):3000\s+\S+\s+LISTENING\s+(\d+)\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var processId)) return null;
        try { return Process.GetProcessById(processId).ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase) ? processId : null; }
        catch { return null; }
    }

    static CommandResult Run(string fileName, string arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo { FileName = fileName, Arguments = arguments, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
            if (process is null) return new CommandResult(-1, "プロセスを開始できませんでした。");
            var standardOutput = process.StandardOutput.ReadToEndAsync();
            var standardError = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(3000))
            {
                try { process.Kill(true); } catch { }
                return new CommandResult(-1, "コマンドが3秒以内に応答しませんでした。Tailscaleが起動・ログイン済みか確認してください。");
            }
            Task.WaitAll([standardOutput, standardError], 1000);
            return new CommandResult(process.ExitCode, (standardOutput.Result + standardError.Result).Trim());
        }
        catch (Exception exception) { return new CommandResult(-1, exception.Message); }
    }

    static string FindRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "server.mjs"))) directory = directory.Parent;
        return directory?.FullName ?? AppContext.BaseDirectory;
    }

    readonly record struct CommandResult(int ExitCode, string Output);
}
