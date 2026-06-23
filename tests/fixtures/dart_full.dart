
import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class WeatherService {
  final String apiKey;
  final String baseUrl;
  WeatherService({required this.apiKey, this.baseUrl = 'https://api.weather.com'});

  Future<Map<String, dynamic>> getCurrentWeather(String city) async {
    final url = Uri.parse('$baseUrl/current?q=$city&appid=$apiKey');
    try {
      final response = await http.get(url).timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      } else {
        throw WeatherException('Failed to load weather: ${response.statusCode}');
      }
    } on TimeoutException {
      throw WeatherException('Request timed out');
    } catch (e) {
      throw WeatherException('Network error: $e');
    }
  }

  Stream<Map<String, dynamic>> weatherStream(String city, Duration interval) async* {
    while (true) {
      try {
        final data = await getCurrentWeather(city);
        yield data;
      } catch (e) {
        print('Stream error: $e');
      }
      await Future.delayed(interval);
    }
  }
}

class WeatherException implements Exception {
  final String message;
  WeatherException(this.message);
  @override
  String toString() => 'WeatherException: $message';
}
