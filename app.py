from flask import Flask, render_template, request, jsonify, send_from_directory
import yt_dlp as youtube_dl
import os
import threading

app = Flask(__name__)
DOWNLOAD_FOLDER = 'downloads'
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)
completed_downloads = {}

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/search', methods=['POST'])
def search():
    query = request.form.get('query')
    if not query:
        return jsonify({"status": "error", "message": "No query provided!"}), 400

    ydl_opts = {
        'quiet': True,
        'skip_download': True,
        'noplaylist': True,
        'extract_flat': 'in_playlist',
    }

    try:
        with youtube_dl.YoutubeDL(ydl_opts) as ydl:
            results = ydl.extract_info(f"ytsearch50:{query}", download=False)['entries']
            videos = [{
                'title': v.get('title'),
                'url': v.get('url') if v.get('url', '').startswith('http') else f"https://www.youtube.com/watch?v={v.get('id')}",
                'thumbnail': f"https://i.ytimg.com/vi/{v.get('id')}/hqdefault.jpg"
            } for v in results]

        return jsonify({"status": "success", "results": videos})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/download', methods=['POST'])
def download():
    url = request.form.get('url')
    format_type = request.form.get('format', 'video')

    if not url:
        return jsonify({"status": "error", "message": "No URL provided!"}), 400

    def thread_callback(data):
        if data['status'] == 'finished':
            completed_downloads['last'] = data

    threading.Thread(target=download_video, args=(url, format_type, thread_callback), daemon=True).start()
    return jsonify({"status": "success", "message": "Download started!"})

def download_video(url, format_type, callback):
    try:
        if format_type == 'audio':
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(DOWNLOAD_FOLDER, '%(title)s.%(ext)s'),
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }],
                'progress_hooks': [callback],
            }
        else:
            ydl_opts = {
                'format': 'best',
                'outtmpl': os.path.join(DOWNLOAD_FOLDER, '%(title)s.%(ext)s'),
                'progress_hooks': [callback],
            }

        with youtube_dl.YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(info_dict)
            callback({'status': 'finished', 'video_title': info_dict['title'], 'video_filename': os.path.basename(filename)})

    except Exception as e:
        callback({'status': 'error', 'message': str(e)})

@app.route('/check-completed')
def check_completed():
    last_download = completed_downloads.get('last')
    if last_download:
        return jsonify({
            "status": "finished",
            "filename": last_download['video_filename'],
            "path": f"/download/{last_download['video_filename']}"
        })
    else:
        return jsonify({"status": "pending"})

@app.route('/download/<filename>')
def download_file(filename):
    return send_from_directory(DOWNLOAD_FOLDER, filename)

if __name__ == '__main__':
    app.run(debug=False)


