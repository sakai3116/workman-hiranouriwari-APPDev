using System.Diagnostics;
using System.Net.Http;

namespace WorkmanServiceManager;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new ServiceManagerForm());
    }
}

internal sealed class ServiceManagerForm : Form
{
    private const string AppUrl = "http://127.0.0.1:3000/";
    private readonly Label statusLabel = new();
    private readonly Button startButton = new();
    private readonly Button stopButton = new();
    private readonly Button checkButton = new();
    private readonly Label locationLabel = new();
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly string? projectRoot;

    public ServiceManagerForm()
    {
        projectRoot = FindProjectRoot();

        Text = "ワークマンアプリ サービス管理";
        ClientSize = new Size(500, 310);
        MinimumSize = new Size(500, 310);
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(255, 252, 245);
        Font = new Font("Yu Gothic UI", 10);

        var header = new Panel
        {
            Dock = DockStyle.Top,
            Height = 78,
            BackColor = Color.FromArgb(242, 170, 32)
        };
        header.Controls.Add(new Label
        {
            AutoSize = true,
            Location = new Point(24, 18),
            Text = "ワークマンアプリ",
            Font = new Font("Yu Gothic UI", 16, FontStyle.Bold),
            ForeColor = Color.FromArgb(23, 36, 51)
        });
        header.Controls.Add(new Label
        {
            AutoSize = true,
            Location = new Point(25, 47),
            Text = "ローカルWebサーバーの起動・状態確認",
            ForeColor = Color.FromArgb(98, 74, 23)
        });
        Controls.Add(header);

        statusLabel.AutoSize = false;
        statusLabel.Location = new Point(25, 105);
        statusLabel.Size = new Size(450, 50);
        statusLabel.Padding = new Padding(12);
        statusLabel.BackColor = Color.FromArgb(255, 244, 216);
        statusLabel.ForeColor = Color.FromArgb(99, 74, 20);
        statusLabel.Text = "状態を確認してください。";
        Controls.Add(statusLabel);

        startButton.Text = "サーバーを起動";
        startButton.Location = new Point(25, 177);
        startButton.Size = new Size(140, 50);
        startButton.BackColor = Color.FromArgb(242, 170, 32);
        startButton.FlatStyle = FlatStyle.Flat;
        startButton.FlatAppearance.BorderColor = Color.FromArgb(217, 145, 12);
        startButton.Click += async (_, _) => await StartServerAsync();
        Controls.Add(startButton);

        stopButton.Text = "サーバーを停止";
        stopButton.Location = new Point(180, 177);
        stopButton.Size = new Size(140, 50);
        stopButton.BackColor = Color.FromArgb(255, 245, 245);
        stopButton.ForeColor = Color.FromArgb(150, 48, 48);
        stopButton.FlatStyle = FlatStyle.Flat;
        stopButton.FlatAppearance.BorderColor = Color.FromArgb(217, 166, 166);
        stopButton.Click += async (_, _) => await StopServerAsync();
        Controls.Add(stopButton);

        checkButton.Text = "状態を確認";
        checkButton.Location = new Point(335, 177);
        checkButton.Size = new Size(140, 50);
        checkButton.BackColor = Color.White;
        checkButton.FlatStyle = FlatStyle.Flat;
        checkButton.FlatAppearance.BorderColor = Color.FromArgb(198, 167, 99);
        checkButton.Click += async (_, _) => await CheckStatusAsync();
        Controls.Add(checkButton);

        locationLabel.AutoSize = false;
        locationLabel.Location = new Point(25, 246);
        locationLabel.Size = new Size(450, 42);
        locationLabel.ForeColor = Color.FromArgb(97, 112, 130);
        locationLabel.Text = projectRoot is null
            ? "プロジェクトフォルダ（server.mjs）が見つかりません。"
            : $"対象フォルダ: {projectRoot}";
        Controls.Add(locationLabel);

        Shown += async (_, _) => await CheckStatusAsync();
    }

    private async Task StartServerAsync()
    {
        if (projectRoot is null)
        {
            SetStatus("プロジェクトフォルダが見つからないため、起動できません。", false);
            return;
        }

        if (await IsServerRunningAsync())
        {
            SetStatus("サーバーはすでに起動しています。", true);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "server.mjs",
                WorkingDirectory = projectRoot,
                UseShellExecute = false,
                CreateNoWindow = true
            });

            SetStatus("サーバーを起動中です…", null);
            await Task.Delay(900);
            await CheckStatusAsync();
        }
        catch (Exception exception)
        {
            SetStatus($"起動できませんでした: {exception.Message}", false);
        }
    }

    private async Task CheckStatusAsync()
    {
        SetStatus("状態を確認中です…", null);
        SetButtonsEnabled(false);
        var running = await IsServerRunningAsync();
        SetButtonsEnabled(true);
        SetStatus(running ? $"稼働中: {AppUrl}" : "停止中です。［サーバーを起動］を押してください。", running);
    }

    private async Task StopServerAsync()
    {
        var serverProcess = FindServerProcess();
        if (serverProcess is null)
        {
            SetStatus("停止対象のWebサーバーは見つかりませんでした。", false);
            return;
        }

        var result = MessageBox.Show(
            "ワークマンアプリのWebサーバーを停止します。よろしいですか？",
            "サーバーを停止",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning);

        if (result != DialogResult.Yes)
        {
            return;
        }

        try
        {
            serverProcess.Kill(entireProcessTree: true);
            await serverProcess.WaitForExitAsync();
            SetStatus("サーバーを停止しました。", false);
        }
        catch (Exception exception)
        {
            SetStatus($"停止できませんでした: {exception.Message}", false);
        }
    }

    private async Task<bool> IsServerRunningAsync()
    {
        try
        {
            using var response = await httpClient.GetAsync(AppUrl);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException)
        {
            return false;
        }
    }

    private void SetStatus(string message, bool? running)
    {
        statusLabel.Text = message;
        statusLabel.BackColor = running switch
        {
            true => Color.FromArgb(228, 246, 230),
            false => Color.FromArgb(255, 235, 235),
            _ => Color.FromArgb(255, 244, 216)
        };
        statusLabel.ForeColor = running switch
        {
            true => Color.FromArgb(38, 111, 50),
            false => Color.FromArgb(150, 48, 48),
            _ => Color.FromArgb(99, 74, 20)
        };
    }

    private void SetButtonsEnabled(bool enabled)
    {
        startButton.Enabled = enabled;
        stopButton.Enabled = enabled;
        checkButton.Enabled = enabled;
    }

    private static Process? FindServerProcess()
    {
        using var netstat = Process.Start(new ProcessStartInfo
        {
            FileName = "netstat",
            Arguments = "-ano -p tcp",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true
        });

        if (netstat is null)
        {
            return null;
        }

        var output = netstat.StandardOutput.ReadToEnd();
        netstat.WaitForExit();
        foreach (var line in output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries))
        {
            if (!line.Contains("127.0.0.1:3000", StringComparison.Ordinal) ||
                !line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var columns = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (!int.TryParse(columns.LastOrDefault(), out var processId))
            {
                continue;
            }

            try
            {
                var process = Process.GetProcessById(processId);
                if (string.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                {
                    return process;
                }
            }
            catch (ArgumentException)
            {
                // The process ended while checking it.
            }
        }

        return null;
    }

    private static string? FindProjectRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "server.mjs")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return null;
    }
}
