using System.Diagnostics;

ApplicationConfiguration.Initialize();
Application.Run(new ControlForm());

sealed class ControlForm : Form
{
    readonly Label web = new() { AutoSize = true };
    readonly Label db = new() { AutoSize = true };
    const string PgService = "postgresql-x64-18";
    public ControlForm()
    {
        Text = "ワークマンアプリ Web／DB管理"; ClientSize = new Size(580, 310); BackColor = Color.White;
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, Padding = new Padding(24), AutoScroll = true };
        panel.Controls.Add(new Label { Text = "ワークマンアプリ サービス管理", Font = new Font("Yu Gothic UI", 16, FontStyle.Bold), AutoSize = true });
        panel.Controls.Add(MakeGroup("Webサーバー", "IP: 127.0.0.1 / Port: 3000", web, () => StartWeb(), () => StopWeb()));
        panel.Controls.Add(MakeGroup("PostgreSQL DB", "IP: 127.0.0.1 / Port: 5432", db, () => ControlDb("start"), () => ControlDb("stop")));
        var refresh = new Button { Text = "状態を更新", Width = 180, Height = 42 }; refresh.Click += (_, _) => RefreshState(); panel.Controls.Add(refresh); Controls.Add(panel); Shown += (_, _) => RefreshState();
    }
    Control MakeGroup(string title, string address, Label state, Action start, Action stop)
    {
        var group = new GroupBox { Text = title, Width = 520, Height = 100, Padding = new Padding(12) }; var addressLabel = new Label { Text = address, Location = new Point(14, 24), AutoSize = true };
        state.Location = new Point(14, 50); var on = new Button { Text = "起動", Location = new Point(330, 23), Size = new Size(75, 42) }; var off = new Button { Text = "停止", Location = new Point(415, 23), Size = new Size(75, 42) }; on.Click += (_, _) => { start(); RefreshState(); }; off.Click += (_, _) => { stop(); RefreshState(); }; group.Controls.AddRange([addressLabel, state, on, off]); return group;
    }
    void StartWeb() { if (IsWebUp()) return; Process.Start(new ProcessStartInfo { FileName = "node", Arguments = "server.mjs", WorkingDirectory = FindRoot(), UseShellExecute = false, CreateNoWindow = true }); }
    void StopWeb() { foreach (var p in Process.GetProcessesByName("node")) { try { p.Kill(true); } catch { } } }
    void ControlDb(string action) { Process.Start(new ProcessStartInfo { FileName = "sc.exe", Arguments = $"{action} {PgService}", UseShellExecute = false, CreateNoWindow = true })?.WaitForExit(); }
    void RefreshState() { web.Text = "状態: " + (IsWebUp() ? "稼働中" : "停止中"); db.Text = "状態: " + (IsDbUp() ? "稼働中" : "停止中"); }
    static bool IsDbUp() { var p = Process.Start(new ProcessStartInfo { FileName = "sc.exe", Arguments = $"query {PgService}", UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true }); if (p is null) return false; var output = p.StandardOutput.ReadToEnd(); p.WaitForExit(); return output.Contains("RUNNING"); }
    static bool IsWebUp() { try { using var c = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) }; return c.GetAsync("http://127.0.0.1:3000/").GetAwaiter().GetResult().IsSuccessStatusCode; } catch { return false; } }
    static string FindRoot() { var d = new DirectoryInfo(AppContext.BaseDirectory); while (d != null && !File.Exists(Path.Combine(d.FullName, "server.mjs"))) d = d.Parent; return d?.FullName ?? AppContext.BaseDirectory; }
}
